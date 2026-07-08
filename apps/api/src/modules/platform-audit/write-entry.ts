import { createHmac } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { platformAuditEvents } from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import { sortKeys } from '../audit/write-entry.js'
import { isForbiddenAuditKey, sanitizeAuditPayload } from '../../lib/secure-route.js'
import { getPlatformAuditKey } from '../vault/key-service.js'
import { currentPlatformAuditKeyVersion } from './key-version.js'

/** Story 9.4 D6: canonical JSON HMAC over the platform audit key — identical mechanism to
 * `computeAuditHmac` (per-row HMAC, no hash chain — the actual shipped mechanism, not the stale
 * "chaining" language in architecture.md/prd.md), but a distinct signing key so blast radius
 * between the two logs is isolated (D3). */
export function computePlatformAuditHmac(
  fields: Record<string, unknown>,
  platformAuditKey: Buffer
): string {
  const canonical = JSON.stringify(sortKeys(fields))
  return createHmac('sha256', platformAuditKey).update(canonical).digest('hex')
}

function containsForbiddenKey(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry, seen))
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => isForbiddenAuditKey(key) || containsForbiddenKey(nested, seen)
  )
}

export type RedactPlatformAuditPayloadOptions = {
  /** Defaults to `env.NODE_ENV === 'production'`. Overridable purely for unit testing both
   * branches without depending on the process-wide cached env singleton. */
  isProduction?: boolean
  onForbiddenKeyStripped?: (message: string) => void
}

/** Story 9.4 AC-6 edge case: a forbidden key (password/secret/etc., reusing the exact
 * `FORBIDDEN_AUDIT_KEYS` set from `lib/secure-route.ts`) making it into a platform-audit payload
 * is always a caller bug, never a legitimate value to persist into this immutable table. Fails
 * loud (throws) outside production so the bug is caught in dev/tests; in production, strips the
 * key(s) and logs a warning instead of taking the whole action down over a logging-only defect. */
export function redactPlatformAuditPayload(
  payload: Record<string, unknown>,
  options: RedactPlatformAuditPayloadOptions = {}
): Record<string, unknown> {
  const isProduction = options.isProduction ?? env.NODE_ENV === 'production'
  const hasForbiddenKey = containsForbiddenKey(payload)

  if (hasForbiddenKey && !isProduction) {
    throw new Error(
      'writePlatformAuditEntry: payload contains a forbidden audit key (password/secret/etc.) — fix the caller instead of persisting it'
    )
  }

  if (hasForbiddenKey) {
    options.onForbiddenKeyStripped?.(
      'writePlatformAuditEntry: stripped forbidden key(s) from payload before persisting'
    )
  }

  return sanitizeAuditPayload(payload)
}

export type PlatformAuditFields = {
  operatorId: string
  actionType: string
  targetOrgId?: string
  targetUserId?: string
  payload: Record<string, unknown>
  ipAddress?: string | null
  /** D8/AC-16: retroactive-drain rows preserve the ORIGINAL attempt time, not the (later) drain
   * time — omitted for every ordinary write, which uses the column's `defaultNow()`. */
  createdAt?: Date
}

/**
 * Story 9.4 AC-6: writes a `platform_audit_events` row in the caller's transaction. Sets
 * `app.platform_operator_verified` on `tx` itself (mirrors `writeHumanAuditEntry`'s own
 * `app.current_org_id` set) so the RLS policy (D4) allows the insert — callers must have already
 * confirmed `requirePlatformOperator()` passed before this is ever reached.
 *
 * Does not itself implement the maintenance-mode fail-open/queue behavior (D8) — that is layered
 * on top by `writePlatformAuditEntryOrFailClosed()` (lib/audit-or-fail-closed.ts), which catches
 * this function's failures and decides whether to queue or rethrow.
 */
export async function writePlatformAuditEntry(tx: Tx, fields: PlatformAuditFields): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.platform_operator_verified', 'true', true)`)
  const keyVersion = await currentPlatformAuditKeyVersion(tx)
  const payload = redactPlatformAuditPayload(fields.payload, {
    onForbiddenKeyStripped: (message) =>
      process.stderr.write(`[platform-audit] WARN: ${message}\n`),
  })

  const hmacFields = {
    operatorId: fields.operatorId,
    actionType: fields.actionType,
    targetOrgId: fields.targetOrgId,
    targetUserId: fields.targetUserId,
    payload,
    keyVersion,
  }
  const hmac = computePlatformAuditHmac(hmacFields, getPlatformAuditKey())

  await tx.insert(platformAuditEvents).values({
    operatorId: fields.operatorId,
    actionType: fields.actionType,
    targetOrgId: fields.targetOrgId ?? null,
    targetUserId: fields.targetUserId ?? null,
    payload,
    ipAddress: fields.ipAddress ?? null,
    keyVersion,
    hmac,
    ...(fields.createdAt ? { createdAt: fields.createdAt } : {}),
  })
}
