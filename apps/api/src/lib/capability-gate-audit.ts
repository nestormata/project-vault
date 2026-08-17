import { getDb, type Tx } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { firstActorTokenIdForUser } from '../modules/audit/actor-token.js'
import { currentAuditKeyVersion } from '../modules/audit/key-version.js'
import { computeAuditHmac } from '../modules/audit/write-entry.js'
import { assertOrgMayWriteAudit, estimateAuditEntrySizeBytes } from '../modules/audit/quota-gate.js'
import { getAuditKey } from '../modules/vault/key-service.js'

/**
 * Story 23.3 AC-25 — audits denials on authenticated, org-scoped enforcement only
 * (`surface === 'org'`, the discriminator AC-10 already carries). `{ permitted: true }` writes
 * nothing. Unauthenticated/public-surface denials are never audited (there is no org actor to
 * attribute them to, and it would be a direct write amplifier reachable by anyone).
 *
 * **Audit-volume dampening (bounded state, PV-owned key, specified flush):** repeated denials for
 * the same `(orgId, userId, capability)` — deliberately NOT keyed on the extension-controlled
 * `reasonCode` (an extension emitting a per-request-unique code must not be able to defeat
 * dampening) — collapse to at most one immediate row plus one flush row per 60s window. The first
 * denial in a window writes immediately (`suppressedCount: 0`, carrying that denial's
 * `reasonCode`). Every subsequent denial for the same tuple inside the window increments an
 * in-memory `suppressedCount` without writing. The pending count is flushed as its own row (same
 * `reasonCode` as the window's first denial) when: (a) the bookkeeping map is swept on any NEW
 * denial for ANY tuple whose window has since expired, (b) the map is at its 1000-entry bound and
 * this tuple is the least-recently-touched entry (LRU eviction), or (c) a test calls the
 * `__flush...ForTests` escape hatch. If neither trigger occurs before the process exits, that
 * window's suppressed count is never separately audited — this is the accepted residual risk: the
 * denial itself is *never* zero-rows (the first denial in every window always writes), only the
 * *magnitude* of a burst can be delayed. The undampened operational log (AC-26) always carries
 * per-event detail regardless.
 *
 * **Per-replica honesty:** this bookkeeping is in-process. Under ADR 0003's multi-instance
 * topology, N replicas each hold their own dampener state, so up to N rows may be written per
 * window across the fleet — this is a single-process property, not a global guarantee.
 *
 * **Divergence from `secureRoute`'s own audit convention (deliberate, record in Dev Notes):** a
 * gate denial is NOT routed through `secure-route.ts`'s `audit_write_failed` 503 path. A denial is
 * a completed authorization outcome, not a partially-applied mutation; downgrading it to a 503
 * would turn an audit hiccup into a *less* restrictive outcome. If the audit write fails, the
 * caller still returns its `403` and the failure is logged.
 */
const AUDIT_DAMPEN_WINDOW_MS = 60_000
const AUDIT_DAMPEN_MAX_ENTRIES = 1000

type DampenerEntry = { windowStart: number; reasonCode: string; suppressedCount: number }

// A Map preserves insertion order; re-`set`ting an existing key moves it to the end, giving a
// cheap LRU (`.keys().next().value` is always the least-recently-touched entry).
const dampener = new Map<string, DampenerEntry>()

function dampenerKey(orgId: string, userId: string, capability: string): string {
  return `${orgId}\x00${userId}\x00${capability}`
}

export type CapabilityAuditWriter = (input: {
  orgId: string
  userId: string
  capability: string
  reasonCode: string
  suppressedCount: number
}) => Promise<void>

async function insertCapabilityDeniedRow(
  tx: Tx,
  input: {
    orgId: string
    userId: string
    capability: string
    reasonCode: string
    suppressedCount: number
  }
): Promise<void> {
  const actorTokenId = await firstActorTokenIdForUser(tx, input.userId)
  const keyVersion = await currentAuditKeyVersion(tx)
  const payload =
    input.suppressedCount > 0
      ? {
          capability: input.capability,
          reasonCode: input.reasonCode,
          suppressedCount: input.suppressedCount,
        }
      : { capability: input.capability, reasonCode: input.reasonCode }
  const fields = {
    orgId: input.orgId,
    actorTokenId,
    actorType: 'human',
    eventType: AuditEvent.CAPABILITY_DENIED,
    resourceId: undefined,
    resourceType: undefined,
    payload,
    keyVersion,
  }
  // Story 22.1 AC-13 (site 9 of 9 — discovered by re-verifying the insert-site count at
  // implementation time per Task 1: Story 23.3 landed after this story was drafted and added this
  // site, so the enumerated "eight sites" is stale documentation drift; there are now nine. Same
  // best-effort-caller contract applies: a refusal here propagates up through
  // recordCapabilityDeniedAudit() to secure-route.ts's auditCapabilityDenialBestEffort(), which
  // already catches and logs rather than turning a completed 403 into a 503 — a capability denial
  // is never blocked on audit-storage quota, consistent with this file's own "never downgrade a
  // 403 into a less-restrictive-looking outcome" rule.
  await assertOrgMayWriteAudit(tx, {
    orgId: input.orgId,
    eventType: AuditEvent.CAPABILITY_DENIED,
    sizeBytes: estimateAuditEntrySizeBytes({ payload }),
  })
  const hmac = computeAuditHmac(fields, getAuditKey())
  await tx.insert(auditLogEntries).values({
    orgId: input.orgId,
    actorTokenId,
    actorType: 'human',
    eventType: AuditEvent.CAPABILITY_DENIED,
    payload,
    keyVersion,
    hmac,
  })
}

const defaultAuditWriter: CapabilityAuditWriter = async (input) => {
  const db = getDb()
  await db.transaction(async (tx) => insertCapabilityDeniedRow(tx as Tx, input))
}

/** Evicts (and, if it has a pending suppressedCount, flushes) the least-recently-touched entry. */
async function evictOldestIfAtCapacity(writer: CapabilityAuditWriter): Promise<void> {
  if (dampener.size < AUDIT_DAMPEN_MAX_ENTRIES) return
  const oldestKey = dampener.keys().next().value
  if (oldestKey === undefined) return
  await flushEntry(oldestKey, writer)
}

async function flushEntry(key: string, writer: CapabilityAuditWriter): Promise<void> {
  const entry = dampener.get(key)
  if (!entry) return
  dampener.delete(key)
  if (entry.suppressedCount <= 0) return
  const [orgId, userId, capability] = key.split('\x00')
  if (!orgId || !userId || !capability) return
  await writer({
    orgId,
    userId,
    capability,
    reasonCode: entry.reasonCode,
    suppressedCount: entry.suppressedCount,
  })
}

/** Sweeps every OTHER tuple whose window has expired — the "flush on any denial" rule. */
async function sweepExpired(
  now: number,
  skipKey: string,
  writer: CapabilityAuditWriter
): Promise<void> {
  const expired: string[] = []
  for (const [key, entry] of dampener) {
    if (key === skipKey) continue
    if (now - entry.windowStart >= AUDIT_DAMPEN_WINDOW_MS) expired.push(key)
  }
  for (const key of expired) await flushEntry(key, writer)
}

/**
 * AC-25 — call on every `surface: 'org'` denial. Writes immediately for the first denial in a
 * 60s window per `(orgId, userId, capability)`; dampens (and eventually flushes) repeats.
 */
export async function recordCapabilityDeniedAudit(
  input: { orgId: string; userId: string; capability: string; reasonCode: string },
  writer: CapabilityAuditWriter = defaultAuditWriter
): Promise<void> {
  const key = dampenerKey(input.orgId, input.userId, input.capability)
  const now = Date.now()

  await sweepExpired(now, key, writer)

  const existing = dampener.get(key)
  if (existing && now - existing.windowStart < AUDIT_DAMPEN_WINDOW_MS) {
    existing.suppressedCount += 1
    // Re-insert to move this key to the end (LRU touch).
    dampener.delete(key)
    dampener.set(key, existing)
    return
  }

  // First denial in a fresh window: write immediately.
  dampener.delete(key)
  await evictOldestIfAtCapacity(writer)
  dampener.set(key, { windowStart: now, reasonCode: input.reasonCode, suppressedCount: 0 })
  await writer({
    orgId: input.orgId,
    userId: input.userId,
    capability: input.capability,
    reasonCode: input.reasonCode,
    suppressedCount: 0,
  })
}

/** Test-only: force-flush every pending dampener entry (simulates window-expiry sweep). */
export async function __flushCapabilityAuditDampenerForTests(
  writer: CapabilityAuditWriter = defaultAuditWriter
): Promise<void> {
  const keys = [...dampener.keys()]
  for (const key of keys) await flushEntry(key, writer)
}

/** Test-only reset — never called from production code. */
export function __resetCapabilityAuditDampenerForTests(): void {
  dampener.clear()
}
