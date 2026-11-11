import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { z } from 'zod/v4'
import { OperationalEvent } from '@project-vault/shared'
import type {
  ServiceEndpointLimits,
  ServiceEndpointLimitsResolver,
} from '@project-vault/extension-api'
import { env } from '../config/env.js'
import type { ExtensionState } from '../extensions/loader.js'
import { operationalLog } from './logger.js'
import { raceWithTimeout } from './race-with-timeout.js'

export const SERVICE_ENDPOINT_LIMITS_TIMEOUT_MS = 250

const GENERIC_UNAVAILABLE_MESSAGE = 'Service endpoint limits are temporarily unavailable.'

export class ServiceEndpointLimitsUnavailableError extends Error {
  readonly code = 'service_endpoint_limits_unavailable'

  constructor() {
    super(GENERIC_UNAVAILABLE_MESSAGE)
    this.name = 'ServiceEndpointLimitsUnavailableError'
  }
}

export class HealthChecksDisabledError extends Error {
  readonly code = 'health_checks_disabled'

  constructor() {
    super('Health checks are not enabled for this organization.')
    this.name = 'HealthChecksDisabledError'
  }
}

export class CheckIntervalTooShortError extends Error {
  readonly code = 'check_interval_too_short'

  constructor(minCheckIntervalSeconds: number) {
    super(`Check interval must be at least ${minCheckIntervalSeconds} seconds`)
    this.name = 'CheckIntervalTooShortError'
  }
}

const limitsSchema = z.object({
  healthChecksEnabled: z.boolean().optional(),
  maxEndpoints: z.number().int().min(1).optional(),
  minCheckIntervalSeconds: z.number().int().min(1).optional(),
})

let registeredResolver: ServiceEndpointLimitsResolver | null = null
let staticLimitsForTests: ServiceEndpointLimits | undefined

export function getServiceEndpointLimitsResolver(): ServiceEndpointLimitsResolver | null {
  return registeredResolver
}

export function wireExtensionServiceEndpointLimits(
  state: ExtensionState,
  logger: Partial<Pick<FastifyBaseLogger, 'warn'>> = {}
): void {
  if (state.status !== 'loaded') return
  const resolver = state.hooks.serviceEndpointLimits
  if (!resolver) return
  if (registeredResolver !== null) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.SERVICE_ENDPOINT_LIMITS_DOUBLE_WIRE_IGNORED,
      'wireExtensionServiceEndpointLimits called a second time in this process — ignored',
      {}
    )
    return
  }
  registeredResolver = resolver
}

export function __resetServiceEndpointLimitsForTests(): void {
  registeredResolver = null
  staticLimitsForTests = undefined
}

export function __setServiceEndpointLimitsResolverForTests(
  resolver: ServiceEndpointLimitsResolver | null
): void {
  registeredResolver = resolver
}

export function __setStaticServiceEndpointLimitsForTests(limits: ServiceEndpointLimits): void {
  staticLimitsForTests = limits
}

export type ResolvedServiceEndpointLimits =
  | {
      status: 'ok'
      healthChecksEnabled: boolean
      maxEndpointsOrg: number | null
      minCheckIntervalSeconds: number | null
    }
  | { status: 'unavailable' }

export type ServiceEndpointMutation = {
  kind: 'create' | 'update'
  enablingCheck: boolean
  intervalSeconds: number | null
  previousIntervalSeconds: number | null
}

export type ServiceEndpointLimitsDecision =
  | { allowed: true }
  | {
      allowed: false
      code:
        | 'service_endpoint_limits_unavailable'
        | 'health_checks_disabled'
        | 'check_interval_too_short'
        | 'service_endpoint_limit_reached'
      message: string
      limit?: number
    }

function staticLimitsFromEnv(): ServiceEndpointLimits {
  if (staticLimitsForTests !== undefined) return staticLimitsForTests
  const limits: ServiceEndpointLimits = {}
  if (env.SERVICE_ENDPOINT_HEALTH_CHECKS_ENABLED !== undefined) {
    limits.healthChecksEnabled = env.SERVICE_ENDPOINT_HEALTH_CHECKS_ENABLED
  }
  if (env.SERVICE_ENDPOINT_MAX_ENDPOINTS !== undefined) {
    limits.maxEndpoints = env.SERVICE_ENDPOINT_MAX_ENDPOINTS
  }
  if (env.SERVICE_ENDPOINT_MIN_CHECK_INTERVAL_SECONDS !== undefined) {
    limits.minCheckIntervalSeconds = env.SERVICE_ENDPOINT_MIN_CHECK_INTERVAL_SECONDS
  }
  return limits
}

function toResolved(raw: ServiceEndpointLimits): ResolvedServiceEndpointLimits {
  return {
    status: 'ok',
    healthChecksEnabled: raw.healthChecksEnabled ?? true,
    maxEndpointsOrg: raw.maxEndpoints ?? null,
    minCheckIntervalSeconds: raw.minCheckIntervalSeconds ?? null,
  }
}

function logUnavailable(
  logger: Partial<Pick<FastifyBaseLogger, 'error' | 'warn'>>,
  orgId: string,
  callId: string,
  subReason: string
): void {
  operationalLog(
    logger,
    'error',
    OperationalEvent.SERVICE_ENDPOINT_LIMITS_UNAVAILABLE,
    'Service endpoint limits resolver failed closed',
    { orgId, callId, subReason }
  )
}

export async function resolveServiceEndpointLimits(input: {
  orgId: string
  projectId: string
  logger?: Partial<Pick<FastifyBaseLogger, 'error' | 'warn'>>
  timeoutMs?: number
}): Promise<ResolvedServiceEndpointLimits> {
  const resolver = registeredResolver
  if (!resolver) return toResolved(staticLimitsFromEnv())

  const callId = randomUUID()
  const logger = input.logger ?? {}
  const timeoutMs = input.timeoutMs ?? SERVICE_ENDPOINT_LIMITS_TIMEOUT_MS
  const raced = await raceWithTimeout(
    () =>
      Promise.resolve().then(() =>
        resolver.onResolveServiceEndpointLimits({
          orgId: input.orgId,
          projectId: input.projectId,
          callId,
        })
      ),
    timeoutMs
  )
  if (raced.status === 'timed_out') {
    logUnavailable(logger, input.orgId, callId, 'timed_out')
    return { status: 'unavailable' }
  }
  if (raced.status === 'rejected') {
    logUnavailable(logger, input.orgId, callId, 'threw')
    return { status: 'unavailable' }
  }
  const parsed = limitsSchema.safeParse(raced.value)
  if (!parsed.success) {
    logUnavailable(logger, input.orgId, callId, 'malformed')
    return { status: 'unavailable' }
  }
  return toResolved(parsed.data)
}

function isShortening(mutation: ServiceEndpointMutation): boolean {
  return (
    mutation.previousIntervalSeconds !== null &&
    mutation.intervalSeconds !== null &&
    mutation.intervalSeconds < mutation.previousIntervalSeconds
  )
}

function raisesIntensity(mutation: ServiceEndpointMutation): boolean {
  if (mutation.kind === 'create') return true
  return mutation.enablingCheck || isShortening(mutation)
}

function refused(
  code: Exclude<ServiceEndpointLimitsDecision, { allowed: true }>['code'],
  message: string,
  limit?: number
): ServiceEndpointLimitsDecision {
  return limit === undefined
    ? { allowed: false, code, message }
    : { allowed: false, code, message, limit }
}

function healthDecision(
  resolved: Extract<ResolvedServiceEndpointLimits, { status: 'ok' }>,
  mutation: ServiceEndpointMutation
): ServiceEndpointLimitsDecision | null {
  if (!resolved.healthChecksEnabled && (mutation.kind === 'create' || mutation.enablingCheck)) {
    return refused('health_checks_disabled', 'Health checks are not enabled for this organization.')
  }
  return null
}

function intervalDecision(
  resolved: Extract<ResolvedServiceEndpointLimits, { status: 'ok' }>,
  mutation: ServiceEndpointMutation
): ServiceEndpointLimitsDecision | null {
  if (
    mutation.intervalSeconds !== null &&
    resolved.minCheckIntervalSeconds !== null &&
    mutation.intervalSeconds < resolved.minCheckIntervalSeconds
  ) {
    return refused(
      'check_interval_too_short',
      `Check interval must be at least ${resolved.minCheckIntervalSeconds} seconds`,
      resolved.minCheckIntervalSeconds
    )
  }
  return null
}

function capDecision(
  resolved: Extract<ResolvedServiceEndpointLimits, { status: 'ok' }>,
  mutation: ServiceEndpointMutation,
  counts: { project: number; org: number; maxPerProject: number }
): ServiceEndpointLimitsDecision | null {
  if (mutation.kind !== 'create') return null
  if (counts.project >= counts.maxPerProject) {
    return refused(
      'service_endpoint_limit_reached',
      `This project has reached its maximum of ${counts.maxPerProject} monitored endpoints`,
      counts.maxPerProject
    )
  }
  if (resolved.maxEndpointsOrg !== null && counts.org >= resolved.maxEndpointsOrg) {
    return refused(
      'service_endpoint_limit_reached',
      `This organization has reached its maximum of ${resolved.maxEndpointsOrg} monitored endpoints`,
      resolved.maxEndpointsOrg
    )
  }
  return null
}

export function decideServiceEndpointMutation(
  resolved: ResolvedServiceEndpointLimits,
  mutation: ServiceEndpointMutation,
  counts: { project: number; org: number; maxPerProject: number }
): ServiceEndpointLimitsDecision {
  if (resolved.status === 'unavailable') {
    return raisesIntensity(mutation)
      ? refused('service_endpoint_limits_unavailable', GENERIC_UNAVAILABLE_MESSAGE)
      : { allowed: true }
  }
  return (
    healthDecision(resolved, mutation) ??
    intervalDecision(resolved, mutation) ??
    capDecision(resolved, mutation, counts) ?? { allowed: true }
  )
}

export function throwServiceEndpointLimitsDecision(
  decision: Exclude<ServiceEndpointLimitsDecision, { allowed: true }>
): never {
  if (decision.code === 'service_endpoint_limits_unavailable') {
    throw new ServiceEndpointLimitsUnavailableError()
  }
  if (decision.code === 'health_checks_disabled') {
    throw new HealthChecksDisabledError()
  }
  if (decision.code === 'check_interval_too_short') {
    throw new CheckIntervalTooShortError(decision.limit ?? 1)
  }
  throw new Error(decision.message)
}

export function serviceEndpointLimitsHttpError(error: unknown): {
  status: 403 | 422 | 503
  code: string
  message: string
} | null {
  if (error instanceof ServiceEndpointLimitsUnavailableError) {
    return { status: 503, code: error.code, message: error.message }
  }
  if (error instanceof HealthChecksDisabledError) {
    return { status: 403, code: error.code, message: error.message }
  }
  if (error instanceof CheckIntervalTooShortError) {
    return { status: 422, code: error.code, message: error.message }
  }
  return null
}
