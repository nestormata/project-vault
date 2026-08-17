import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { z } from 'zod/v4'
import { CapabilityId, OperationalEvent } from '@project-vault/shared'
import type { CapabilityIdValue } from '@project-vault/shared'
import type {
  CapabilityDecision,
  CapabilityGate,
  CapabilityGateContext,
} from '@project-vault/extension-api'
import type { ExtensionState } from '../extensions/loader.js'
import { operationalLog } from './logger.js'

/**
 * Story 23.3 Group B — the capability-gate registry, mirroring
 * `modules/auth/strategies.ts`'s `authStrategies`/`wireExtensionAuthStrategy()` shape exactly.
 * Set-once, read-only after boot: no `unregister`/`replace`/`setCapabilityGate` public API.
 */
let registeredGate: CapabilityGate | null = null
let registeredGateName: string | null = null

export function getCapabilityGate(): CapabilityGate | null {
  return registeredGate
}

/** AC-26: the registering extension's manifest name, for `/status`'s gate-identity field. */
export function getCapabilityGateName(): string | null {
  return registeredGateName
}

/**
 * AC-7: the `createApp()` wiring step, called once after `loadExtension()` resolves — on the very
 * next line after `wireExtensionAuthStrategy(getExtensionStatus())`. No-ops (never throws) for
 * every state except `loaded` with a `capabilityGate` hook declared. A second call in the same
 * process (AC-7 edge case: double invocation) no-ops and logs
 * `CAPABILITY_GATE_DOUBLE_WIRE_IGNORED` at `warn` rather than replacing an already-registered gate.
 */
export function wireExtensionCapabilityGate(
  state: ExtensionState,
  logger: Partial<Pick<FastifyBaseLogger, 'warn'>> = {}
): void {
  if (state.status !== 'loaded') return
  const capabilityGate = state.hooks.capabilityGate
  if (!capabilityGate) return
  if (registeredGate !== null) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.CAPABILITY_GATE_DOUBLE_WIRE_IGNORED,
      'wireExtensionCapabilityGate called a second time in this process — ignored, the already-registered gate was kept',
      {}
    )
    return
  }
  registeredGate = capabilityGate
  registeredGateName = state.manifest.name
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetCapabilityGateForTests(): void {
  registeredGate = null
  registeredGateName = null
}

/**
 * AC-17: PV-internal, injectable timeout constant — NOT part of the published `extension-api`
 * contract (no exported type in that package references it). Provisional; Story 23.4 owns the
 * final value if it lands on a network claim-fetch design.
 */
export const CAPABILITY_GATE_TIMEOUT_MS = 250

/**
 * AC-15: per-surface in-flight cap. Bounds the cost of a slow/hung gate without letting
 * unauthenticated traffic ever change any organization's enforcement outcome — see the
 * `'__public__'` accounting key below. PV-internal, injectable seam; NOT part of the published
 * `extension-api` contract (AC-32).
 */
export const CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE = 8

/** AC-15: the fixed accounting key every unauthenticated call site shares, regardless of orgId. */
const PUBLIC_SURFACE_ACCOUNTING_KEY = '__public__'

const MAX_REASON_CODE_LENGTH = 200
const MESSAGE_TRUNCATE_LENGTH = 300
const TRUNCATION_MARKER = '…'

/**
 * AC-23 — the response-schema shape for a `capability_denied` 403. Routes annotated with
 * `security.capability` must use this (or a union including it) for their `403` response schema
 * instead of the plain `ApiErrorSchema` — otherwise Fastify's schema-driven serialization silently
 * strips the `capability`/`reasonCode` fields `sendCapabilityDenied()` actually sends, even though
 * they leave `secure-route.ts` correctly. `capability`/`reasonCode` are optional here (not present
 * on this route's other possible 403, e.g. `insufficient_role`).
 */
export const CapabilityDeniedErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  capability: z.string().optional(),
  reasonCode: z.string().optional(),
})

/**
 * AC-12: runtime boundary validation — TypeScript types do not survive the extension boundary.
 * `reasonCode` longer than 200 chars is rejected as malformed (never truncated — AC-4's
 * identifier rule). Extra keys on `permitted: true` are stripped (`.strip()` semantics via the
 * discriminated union below), not rejected — forward compatibility, AC-32.
 */
const capabilityDecisionSchema = z.discriminatedUnion('permitted', [
  z.object({ permitted: z.literal(true) }).loose(),
  z.object({
    permitted: z.literal(false),
    reasonCode: z.string().min(1).max(MAX_REASON_CODE_LENGTH),
    message: z.string().optional(),
  }),
])

export type CheckCapabilityInput = {
  capability: CapabilityIdValue
  orgId: string | null
  userId: string | null
  orgRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  /** AC-15: which concurrency budget this call belongs to. */
  surface: 'public' | 'org'
  /** Untrusted, caller-echoed only — see capability-gate.ts's `gateCallId` doc comment. */
  requestId?: string
  logger?: Partial<Pick<FastifyBaseLogger, 'error' | 'warn'>>
  timeoutMs?: number
  maxInFlightPerSurface?: number
  /**
   * AC-10: a caller-owned, per-request `Set` used only to detect (and log) a second check for the
   * same capability id within one request. Never memoizes a decision — a repeat check still
   * invokes the gate; this is a log-only backstop, not a cache.
   */
  perRequestSeen?: Set<string>
}

const PV_LOCALIZED_FALLBACK_MESSAGE = 'This capability is not available for your organization.'

function truncateMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  if (message.length <= MESSAGE_TRUNCATE_LENGTH) return message
  return message.slice(0, MESSAGE_TRUNCATE_LENGTH) + TRUNCATION_MARKER
}

function denial(reasonCode: string, message?: string): CapabilityDecision {
  return {
    permitted: false,
    reasonCode,
    message: truncateMessage(message) ?? PV_LOCALIZED_FALLBACK_MESSAGE,
  }
}

// ---------------------------------------------------------------------------------------------
// AC-26: monotonic in-process counters + rate-limited logging for the high-volume failure events.
// ---------------------------------------------------------------------------------------------

export type CapabilityGateCounters = {
  checks: number
  permitted: number
  denied: number
  failed: number
  saturated: number
}

function freshCounters(): CapabilityGateCounters {
  return { checks: 0, permitted: 0, denied: 0, failed: 0, saturated: 0 }
}

let counters: CapabilityGateCounters = freshCounters()

/** AC-26: exposed (read-only copy) for `apps/api/src/routes/status.ts`. */
export function getCapabilityGateCounters(): CapabilityGateCounters {
  return { ...counters }
}

/** Test-only reset — never called from production code. */
export function __resetCapabilityGateCountersForTests(): void {
  counters = freshCounters()
}

/**
 * AC-26: `CAPABILITY_GATE_FAILED`/`_TIMED_OUT`/`_SATURATED` are rate-limited to at most 1 per
 * capability id per second, with a `suppressedCount` on the next emitted line. Every other
 * CAPABILITY_GATE_* event is low-volume/high-signal and is never rate-limited.
 */
const RATE_LIMITED_EVENTS: Set<string> = new Set([
  OperationalEvent.CAPABILITY_GATE_FAILED,
  OperationalEvent.CAPABILITY_GATE_TIMED_OUT,
  OperationalEvent.CAPABILITY_GATE_SATURATED,
])
const RATE_LIMIT_WINDOW_MS = 1000
const rateLimitState = new Map<string, { lastEmittedAt: number; suppressedCount: number }>()

/** Test-only reset — never called from production code. */
export function __resetCapabilityGateRateLimitForTests(): void {
  rateLimitState.clear()
}

type GateLogger = Partial<Pick<FastifyBaseLogger, 'error' | 'warn'>>
type LogFields = {
  capability: string
  orgId: string | null
  gateCallId: string
  requestId?: string
}

function logGateEvent(
  logger: GateLogger,
  level: 'warn' | 'error',
  eventType: string,
  message: string,
  fields: LogFields & { subReason?: string }
): void {
  if (!RATE_LIMITED_EVENTS.has(eventType)) {
    operationalLog(logger, level, eventType, message, fields)
    return
  }
  const key = `${eventType}:${fields.capability}`
  const now = Date.now()
  const state = rateLimitState.get(key)
  if (state && now - state.lastEmittedAt < RATE_LIMIT_WINDOW_MS) {
    state.suppressedCount += 1
    return
  }
  const suppressedCount = state?.suppressedCount ?? 0
  rateLimitState.set(key, { lastEmittedAt: now, suppressedCount: 0 })
  operationalLog(logger, level, eventType, message, { ...fields, suppressedCount })
}

// ---------------------------------------------------------------------------------------------
// AC-15: per-surface in-flight cap. Bounded state — an entry exists only while its key has a
// non-zero count and is deleted at zero, so its size is bounded by the number of concurrently
// in-flight gated requests. No LRU, no TTL, no sweeper.
// ---------------------------------------------------------------------------------------------
const inFlightCounts = new Map<string, number>()

function accountingKeyFor(surface: 'public' | 'org', orgId: string | null): string {
  // AC-15: EVERY public-surface call shares the fixed key, unconditionally — never the resolved
  // orgId, even when a valid token resolves one. Only the concurrency accounting is bucketed by
  // surface; the gate itself still receives the real orgId in its CapabilityGateContext.
  if (surface === 'public') return PUBLIC_SURFACE_ACCOUNTING_KEY
  return orgId ?? PUBLIC_SURFACE_ACCOUNTING_KEY
}

/** Test-only introspection — never called from production code. */
export function __getCapabilityGateInFlightCountForTests(key: string): number {
  return inFlightCounts.get(key) ?? 0
}

/** Test-only reset — never called from production code. */
export function __resetCapabilityGateInFlightForTests(): void {
  inFlightCounts.clear()
}

function tryAcquireSlot(key: string, max: number): boolean {
  const current = inFlightCounts.get(key) ?? 0
  if (current >= max) return false
  inFlightCounts.set(key, current + 1)
  return true
}

function releaseSlot(key: string): void {
  const current = inFlightCounts.get(key) ?? 0
  if (current <= 1) inFlightCounts.delete(key)
  else inFlightCounts.set(key, current - 1)
}

/**
 * AC-11/AC-12/AC-18 — races a single `onCheckCapability()` invocation against
 * `CAPABILITY_GATE_TIMEOUT_MS`, matching `loader.ts:raceWithTimeout()`'s pattern exactly: an eager
 * no-op `.catch()` on the attempt promise so a late rejection after the timeout has already won
 * can never produce an `unhandledRejection`, and a late resolution is simply never consumed.
 */
async function invokeGateWithTimeout(
  gate: CapabilityGate,
  context: CapabilityGateContext,
  timeoutMs: number
): Promise<{ decision: CapabilityDecision } | { timedOut: true } | { error: unknown }> {
  const attempt = (async () => gate.onCheckCapability(context))()
  attempt.catch(() => undefined)

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('capability gate timed out')), timeoutMs)
  })

  try {
    const decision = await Promise.race([attempt, timeoutPromise])
    return { decision }
  } catch (error) {
    if (error instanceof Error && error.message === 'capability gate timed out') {
      return { timedOut: true }
    }
    return { error }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

/**
 * AC-12: a permitted:true decision carrying a reasonCode is the one malformed shape that GRANTS
 * access — most likely an inverted boolean bug. Honor the explicit permitted:true (do not
 * silently strip-and-say-nothing) but log loudly.
 */
function handlePermittedDecision(
  rawDecision: unknown,
  logger: GateLogger,
  fields: LogFields
): CapabilityDecision {
  const hasReasonCode =
    rawDecision !== null &&
    typeof rawDecision === 'object' &&
    'reasonCode' in (rawDecision as Record<string, unknown>)
  if (hasReasonCode) {
    logGateEvent(
      logger,
      'warn',
      OperationalEvent.CAPABILITY_GATE_SUSPICIOUS_DECISION,
      'Capability gate returned permitted:true with a reasonCode present',
      { ...fields, subReason: 'permitted_with_reason_code' }
    )
  }
  return { permitted: true }
}

function recordOutcome(decision: CapabilityDecision): void {
  if (decision.permitted) counters.permitted += 1
  else counters.denied += 1
}

/** AC-10: log-only double-check backstop — never memoizes, never throws in production. */
function checkForDoubleCheck(input: CheckCapabilityInput, fields: LogFields): void {
  if (!input.perRequestSeen) return
  if (input.perRequestSeen.has(input.capability)) {
    logGateEvent(
      input.logger ?? {},
      'error',
      OperationalEvent.CAPABILITY_GATE_DOUBLE_CHECK,
      'The same capability id was checked twice within one request',
      fields
    )
    return
  }
  input.perRequestSeen.add(input.capability)
}

/**
 * AC-11/AC-12/AC-20/AC-21 — the sole entry point that invokes a registered `CapabilityGate`.
 * `{ permitted: true }` from a NO gate is never produced here: the caller (`secure-route.ts`'s
 * `enforceProtectedGuards()` step, or `assertCapability()`) is responsible for AC-5's fail-open
 * short-circuit when `getCapabilityGate()` returns null — this function is only ever called with
 * a non-null gate.
 */
function isKnownCapabilityId(capability: string): boolean {
  return (Object.values(CapabilityId) as string[]).includes(capability)
}

/** Resolves a settled `invokeGateWithTimeout()` outcome into a final, counted CapabilityDecision. */
function resolveGateOutcome(
  outcome: Awaited<ReturnType<typeof invokeGateWithTimeout>>,
  logger: GateLogger,
  fields: LogFields
): CapabilityDecision {
  if ('timedOut' in outcome) {
    counters.failed += 1
    logGateEvent(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_TIMED_OUT,
      'Capability gate timed out',
      fields
    )
    const decision = denial('gate_unavailable')
    recordOutcome(decision)
    return decision
  }

  if ('error' in outcome) {
    counters.failed += 1
    // AC-26: log payloads carry only a fixed-enum classification, NEVER the extension's raw
    // exception message or stack (which could carry internal credentials or claim material) —
    // Story 14.2's fixed-enum boot-log redaction precedent, not Story 14.3's per-request
    // message-logging allowance.
    logGateEvent(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_FAILED,
      'Capability gate threw or rejected',
      { ...fields, subReason: 'gate_threw_or_rejected' }
    )
    const decision = denial('gate_unavailable')
    recordOutcome(decision)
    return decision
  }

  const parsed = capabilityDecisionSchema.safeParse(outcome.decision)
  if (!parsed.success) {
    logGateEvent(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_MALFORMED_DECISION,
      'Capability gate returned a malformed decision',
      fields
    )
    const decision = denial('gate_malformed_decision')
    recordOutcome(decision)
    return decision
  }

  if (parsed.data.permitted === true) {
    const decision = handlePermittedDecision(outcome.decision, logger, fields)
    recordOutcome(decision)
    return decision
  }

  const decision: CapabilityDecision = {
    permitted: false,
    reasonCode: parsed.data.reasonCode,
    message: truncateMessage(parsed.data.message) ?? PV_LOCALIZED_FALLBACK_MESSAGE,
  }
  recordOutcome(decision)
  return decision
}

export async function checkCapability(
  gate: CapabilityGate,
  input: CheckCapabilityInput
): Promise<CapabilityDecision> {
  const logger = input.logger ?? {}
  const gateCallId = randomUUID()
  const fields: LogFields = {
    capability: input.capability,
    orgId: input.orgId,
    gateCallId,
    requestId: input.requestId, // untrusted, caller-echoed
  }
  counters.checks += 1
  checkForDoubleCheck(input, fields)

  // AC-22 runtime backstop: an id reaching here outside the closed CapabilityId set denies rather
  // than silently going ungated. secureRoute()'s boot-time check (AC-22 primary) already prevents
  // this for the declarative form; this covers a hand-built assertCapability() call.
  if (!isKnownCapabilityId(input.capability)) {
    logGateEvent(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_UNKNOWN_ID,
      'assertCapability/checkCapability received an id outside the closed CapabilityId set',
      fields
    )
    const decision = denial('unknown_capability')
    recordOutcome(decision)
    return decision
  }

  const accountingKey = accountingKeyFor(input.surface, input.orgId)
  const maxInFlight = input.maxInFlightPerSurface ?? CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE
  if (!tryAcquireSlot(accountingKey, maxInFlight)) {
    counters.saturated += 1
    logGateEvent(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_SATURATED,
      'Capability gate check denied without invoking the gate — accounting key at its in-flight cap',
      { ...fields, subReason: 'gate_saturated' }
    )
    const decision = denial('gate_unavailable')
    recordOutcome(decision)
    return decision
  }

  try {
    const context: CapabilityGateContext = {
      capability: input.capability,
      orgId: input.orgId,
      userId: input.userId,
      orgRole: input.orgRole,
      gateCallId,
    }
    const timeoutMs = input.timeoutMs ?? CAPABILITY_GATE_TIMEOUT_MS
    const outcome = await invokeGateWithTimeout(gate, context, timeoutMs)
    return resolveGateOutcome(outcome, logger, fields)
  } finally {
    releaseSlot(accountingKey)
  }
}

export type AssertCapabilityInput = {
  capability: CapabilityIdValue
  orgId: string | null
  userId: string | null
  orgRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  /** Which concurrency budget and audit policy this call site belongs to — see AC-15, AC-25. */
  surface: 'public' | 'org'
  requestId?: string
  logger?: Partial<Pick<FastifyBaseLogger, 'error' | 'warn'>>
  perRequestSeen?: Set<string>
}

/**
 * AC-10/AC-24 — the imperative call site, for routes where the org only resolves inside the
 * handler (the public status page). Fails OPEN (`{ permitted: true }`) when no gate is registered
 * — AC-5's byte-identical-when-unconfigured guarantee — and otherwise delegates to
 * `checkCapability()`. MUST be called before any Postgres connection is checked out on behalf of
 * the calling request (AC-19's pool-checkout probe is the normative assertion of this).
 */
export async function assertCapability(input: AssertCapabilityInput): Promise<CapabilityDecision> {
  const gate = getCapabilityGate()
  if (!gate) return { permitted: true }
  return checkCapability(gate, {
    capability: input.capability,
    orgId: input.orgId,
    userId: input.userId,
    orgRole: input.orgRole,
    surface: input.surface,
    requestId: input.requestId,
    logger: input.logger,
    perRequestSeen: input.perRequestSeen,
  })
}
