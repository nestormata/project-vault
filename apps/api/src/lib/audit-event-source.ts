import type { FastifyBaseLogger } from 'fastify'
import { withOrg } from '@project-vault/db'
import { OperationalEvent } from '@project-vault/shared'
import type {
  AuditEventSourceWriteInput,
  AuditEventSourceWriteResult,
  ExtensionManifest,
} from '@project-vault/extension-api'
import { writeExtensionAuditEntry } from '../modules/audit/extension-entry.js'
import { SameTransactionAuditWriteError } from './secure-route.js'
import { operationalLog } from './logger.js'

/**
 * Story 23.8 AC-16 — thrown when the loaded extension's manifest never declared
 * `'audit-event-source'` but `writeAuditEvent()` was called anyway. `HostServices` has no
 * conditional shape (AC-4's edge case), so this is the runtime enforcement.
 */
export class ExtensionAuditCapabilityNotDeclaredError extends Error {
  constructor(manifestName: string) {
    super(
      `Extension "${manifestName}" called auditEventSource.writeAuditEvent() but its manifest does not declare the "audit-event-source" capability`
    )
    this.name = 'ExtensionAuditCapabilityNotDeclaredError'
  }
}

/** Story 23.8 AC-15 — thrown when `input.eventType` does not match `ext.<manifest.name>.<suffix>`. */
export class ExtensionAuditEventTypeNamespaceError extends Error {
  constructor(manifestName: string, eventType: string) {
    super(
      `Extension "${manifestName}" called auditEventSource.writeAuditEvent() with eventType "${eventType.slice(0, 200)}", which does not match the required namespace "ext.${manifestName}."`
    )
    this.name = 'ExtensionAuditEventTypeNamespaceError'
  }
}

// AC-15: bounded length for the full eventType string, reusing the MAX_REASON_CODE_LENGTH-style
// bound convention capability-gate.ts already established for extension-boundary strings.
const MAX_EVENT_TYPE_LENGTH = 200

/** Escapes regex metacharacters in the manifest name before embedding it in the namespace pattern
 * — a manifest name is reverse-DNS-style (register-extension.ts's REVERSE_DNS_NAME_PATTERN,
 * `[a-z0-9]+(\.[a-z0-9-]+)+`) so this is defensive, not a real attacker-controlled-regex risk. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function buildNamespacePattern(manifestName: string): RegExp {
  const escapedName = escapeRegExp(manifestName)
  // manifestName is host-derived (the loaded extension's own already-validated reverse-DNS
  // manifest.name), never caller-supplied per-call input.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(String.raw`^ext\.${escapedName}\.[a-z0-9_]+(\.[a-z0-9_]+)*$`)
}

/**
 * Story 23.8 AC-15/AC-16 — validates the namespace/capability-declaration gates synchronously,
 * BEFORE any transaction opens (fail fast, no wasted DB round-trip). Throws a typed error on
 * failure; returns void on success.
 */
function assertMayWriteExtensionAuditEvent(
  manifest: ExtensionManifest,
  input: AuditEventSourceWriteInput
): void {
  // AC-16: checked on EVERY call, not just once at boot — defense in depth.
  if (!manifest.capabilities.includes('audit-event-source')) {
    throw new ExtensionAuditCapabilityNotDeclaredError(manifest.name)
  }

  if (
    input.eventType.length > MAX_EVENT_TYPE_LENGTH ||
    !buildNamespacePattern(manifest.name).test(input.eventType)
  ) {
    throw new ExtensionAuditEventTypeNamespaceError(manifest.name, input.eventType)
  }
}

// ---------------------------------------------------------------------------------------------
// AC-24: monotonic in-process counters, mirroring capability-gate.ts's CapabilityGateCounters
// precedent. Never keyed by orgId or eventType (unbounded cardinality).
// ---------------------------------------------------------------------------------------------

export type AuditEventSourceCounters = {
  writes: number
  succeeded: number
  rejected: number
}

function freshCounters(): AuditEventSourceCounters {
  return { writes: 0, succeeded: 0, rejected: 0 }
}

let counters: AuditEventSourceCounters = freshCounters()

/** AC-24: exposed (read-only copy) for `apps/api/src/routes/status.ts`. */
export function getAuditEventSourceCounters(): AuditEventSourceCounters {
  return { ...counters }
}

/** Test-only reset — never called from production code. */
export function __resetAuditEventSourceCountersForTests(): void {
  counters = freshCounters()
}

// ---------------------------------------------------------------------------------------------
// AC-23: operational logging, rate-limited for the high-volume SUCCEEDED event — same
// 1-per-second-per-eventType convention capability-gate.ts's RATE_LIMITED_EVENTS established.
// ---------------------------------------------------------------------------------------------

export type ExtensionAuditRejectReason =
  'capability_not_declared' | 'event_type_namespace_violation' | 'quota_exhausted' | 'write_failed'

const RATE_LIMIT_WINDOW_MS = 1000
const rateLimitState = new Map<string, { lastEmittedAt: number; suppressedCount: number }>()

/** Test-only reset — never called from production code. */
export function __resetAuditEventSourceRateLimitForTests(): void {
  rateLimitState.clear()
}

type EventSourceLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn'>>

// AC-23: field name deliberately "auditEventType", never "eventType" — operationalLog()'s own
// payload always sets `eventType` to the OPERATIONAL log event name (e.g.
// "extension_audit_event.write_succeeded"); reusing that key for the audited eventType would
// silently clobber it.
function logSucceeded(logger: EventSourceLogger, auditEventType: string): void {
  const now = Date.now()
  const state = rateLimitState.get(auditEventType)
  if (state && now - state.lastEmittedAt < RATE_LIMIT_WINDOW_MS) {
    state.suppressedCount += 1
    return
  }
  const suppressedCount = state?.suppressedCount ?? 0
  rateLimitState.set(auditEventType, { lastEmittedAt: now, suppressedCount: 0 })
  operationalLog(
    logger,
    'info',
    OperationalEvent.EXTENSION_AUDIT_EVENT_WRITE_SUCCEEDED,
    'extension audit event write succeeded',
    { auditEventType, suppressedCount }
  )
}

function logRejected(
  logger: EventSourceLogger,
  auditEventType: string,
  reason: ExtensionAuditRejectReason
): void {
  operationalLog(
    logger,
    'warn',
    OperationalEvent.EXTENSION_AUDIT_EVENT_WRITE_REJECTED,
    'extension audit event write rejected',
    { auditEventType, reason }
  )
}

/**
 * Story 23.8 AC-7/AC-15/AC-16/AC-17/AC-18/AC-19 — the host-side function bound to one manifest,
 * called by `loader.ts`'s `buildHostServices()`. Opens a FRESH transaction per call (`withOrg`) —
 * never a `Tx` shared across calls or handed to the extension. Never swallows an error: every
 * failure mode propagates as a rejected promise (AC-18).
 */
export async function writeExtensionAuditEventForManifest(
  manifest: ExtensionManifest,
  input: AuditEventSourceWriteInput,
  deps: { logger?: EventSourceLogger } = {}
): Promise<AuditEventSourceWriteResult> {
  const logger = deps.logger ?? {}
  counters.writes += 1

  try {
    assertMayWriteExtensionAuditEvent(manifest, input)
  } catch (error) {
    counters.rejected += 1
    const reason: ExtensionAuditRejectReason =
      error instanceof ExtensionAuditCapabilityNotDeclaredError
        ? 'capability_not_declared'
        : 'event_type_namespace_violation'
    logRejected(logger, input.eventType, reason)
    throw error
  }

  try {
    const row = await withOrg(input.orgId, (tx) =>
      writeExtensionAuditEntry(tx, {
        orgId: input.orgId,
        eventType: input.eventType,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        payload: input.payload,
        extensionName: manifest.name,
      })
    )
    counters.succeeded += 1
    logSucceeded(logger, input.eventType)
    return { id: row.id, createdAt: row.createdAt.toISOString() }
  } catch (error) {
    counters.rejected += 1
    const reason: ExtensionAuditRejectReason =
      error instanceof SameTransactionAuditWriteError && error.code === 'audit_quota_exhausted'
        ? 'quota_exhausted'
        : 'write_failed'
    logRejected(logger, input.eventType, reason)
    throw error
  }
}
