import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { z } from 'zod/v4'
import { OperationalEvent } from '@project-vault/shared'
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

export function getCapabilityGate(): CapabilityGate | null {
  return registeredGate
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
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetCapabilityGateForTests(): void {
  registeredGate = null
}

/**
 * AC-17: PV-internal, injectable timeout constant — NOT part of the published `extension-api`
 * contract (no exported type in that package references it). Provisional; Story 23.4 owns the
 * final value if it lands on a network claim-fetch design.
 */
export const CAPABILITY_GATE_TIMEOUT_MS = 250

const MAX_REASON_CODE_LENGTH = 200
const MESSAGE_TRUNCATE_LENGTH = 300
const TRUNCATION_MARKER = '…'

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
  /** Untrusted, caller-echoed only — see capability-gate.ts's `gateCallId` doc comment. */
  requestId?: string
  logger?: Partial<Pick<FastifyBaseLogger, 'error' | 'warn'>>
  timeoutMs?: number
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
 * AC-11/AC-12/AC-20/AC-21 — the sole entry point that invokes a registered `CapabilityGate`.
 * `{ permitted: true }` from a NO gate is never produced here: the caller (`secure-route.ts`'s
 * `enforceProtectedGuards()` step, or `assertCapability()`) is responsible for AC-5's fail-open
 * short-circuit when `getCapabilityGate()` returns null — this function is only ever called with
 * a non-null gate.
 */
type GateLogger = Partial<Pick<FastifyBaseLogger, 'error' | 'warn'>>
type LogFields = {
  capability: string
  orgId: string | null
  gateCallId: string
  requestId?: string
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
    operationalLog(
      logger,
      'warn',
      OperationalEvent.CAPABILITY_GATE_SUSPICIOUS_DECISION,
      'Capability gate returned permitted:true with a reasonCode present',
      { ...fields, subReason: 'permitted_with_reason_code' }
    )
  }
  return { permitted: true }
}

export async function checkCapability(
  gate: CapabilityGate,
  input: CheckCapabilityInput
): Promise<CapabilityDecision> {
  const logger = input.logger ?? {}
  const gateCallId = randomUUID()
  const context: CapabilityGateContext = {
    capability: input.capability,
    orgId: input.orgId,
    userId: input.userId,
    orgRole: input.orgRole,
    gateCallId,
  }
  const timeoutMs = input.timeoutMs ?? CAPABILITY_GATE_TIMEOUT_MS
  const fields: LogFields = {
    capability: input.capability,
    orgId: input.orgId,
    gateCallId,
    requestId: input.requestId, // untrusted, caller-echoed
  }

  const outcome = await invokeGateWithTimeout(gate, context, timeoutMs)

  if ('timedOut' in outcome) {
    operationalLog(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_TIMED_OUT,
      'Capability gate timed out',
      fields
    )
    return denial('gate_unavailable')
  }

  if ('error' in outcome) {
    operationalLog(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_FAILED,
      'Capability gate threw or rejected',
      {
        ...fields,
        subReason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      }
    )
    return denial('gate_unavailable')
  }

  const parsed = capabilityDecisionSchema.safeParse(outcome.decision)
  if (!parsed.success) {
    operationalLog(
      logger,
      'error',
      OperationalEvent.CAPABILITY_GATE_MALFORMED_DECISION,
      'Capability gate returned a malformed decision',
      fields
    )
    return denial('gate_malformed_decision')
  }

  if (parsed.data.permitted === true) {
    return handlePermittedDecision(outcome.decision, logger, fields)
  }

  return {
    permitted: false,
    reasonCode: parsed.data.reasonCode,
    message: truncateMessage(parsed.data.message) ?? PV_LOCALIZED_FALLBACK_MESSAGE,
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
    requestId: input.requestId,
    logger: input.logger,
  })
}
