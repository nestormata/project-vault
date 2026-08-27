import { and, eq, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { withOrg, type Tx } from '@project-vault/db'
import { extensionEphemeralState } from '@project-vault/db/schema'
import { withSecret, type EncryptedValue } from '@project-vault/crypto'
import type { EphemeralStateHost } from '@project-vault/extension-api'
import { OperationalEvent } from '@project-vault/shared'
import { encryptValue } from './encrypt-value.js'
import { getRequestContext } from './request-context.js'
import { operationalLog } from './logger.js'
import { currentKeyVersion } from '../modules/credentials/db-helpers.js'

/**
 * Story 20.8 — the concrete implementation of `HostServices.ephemeralState`, wired once at
 * extension-load time by `apps/api/src/extensions/loader.ts`'s `buildHostServices()`. See
 * `packages/extension-api/src/hooks/ephemeral-state.ts` for the full contract doc comment this
 * module implements against.
 */

// AC-16 (found during this story's own elicitation pass — 20-7's contract bounds abuse only by
// *count* (AC-11), never by per-entry size). No pre-existing payload-size-bounding constant was
// found in `audit-event-source.ts` — its own bound (`MAX_EVENT_TYPE_LENGTH`) covers `eventType`
// string length, not a `payload` byte-size limit, so despite this story's own Dev Notes text
// pointing at that file for a limit constant to reuse, no such constant actually exists there.
// This is the same class of documentation-vs-shipped-code drift the story's own Context section
// already flags for the job-naming convention — noted in the Dev Agent Record and resolved by
// using AC-16's own literal numbers directly.
export const MAX_KEY_LENGTH = 256
export const MAX_VALUE_BYTES = 16 * 1024
export const MAX_TTL_SECONDS = 3600
export const MAX_LIVE_ENTRIES_PER_ORG = 1000

export class EphemeralStateValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EphemeralStateValidationError'
  }
}

/** AC-4 edge case — thrown by every method when no ambient request context is bound, instead of
 * falling back to a placeholder org id or writing an unscoped row. Unlike
 * `auditOrganizationId()`'s `UNBOUND_CONTEXT_AUDIT_ORG_ID` placeholder (an audit-log annotation),
 * a data write is at stake here, so this fails closed by throwing rather than substituting. */
export class EphemeralStateUnboundContextError extends Error {
  constructor() {
    super(
      'ephemeralState called with no ambient request context bound — refusing to write/read an unscoped row'
    )
    this.name = 'EphemeralStateUnboundContextError'
  }
}

/** AC-11 — thrown (never silently evicting another entry) when a count-increasing write would
 * push an org's live-entry count past MAX_LIVE_ENTRIES_PER_ORG. */
export class EphemeralStateCapExceededError extends Error {
  constructor() {
    super(`extension ephemeral state: org is at its ${MAX_LIVE_ENTRIES_PER_ORG}-live-entry cap`)
    this.name = 'EphemeralStateCapExceededError'
  }
}

/** AC-8 — thrown when the underlying store is unavailable or a query errors. Never leaks the raw
 * driver error message/detail to the extension boundary (same discipline as
 * `org-authorization.ts`'s `INTERNAL_ERROR_REASON_CODE`). */
export class EphemeralStateStoreUnavailableError extends Error {
  constructor() {
    super('ephemeralState: underlying store is unavailable')
    this.name = 'EphemeralStateStoreUnavailableError'
  }
}

/** AC-4 — mirrors `auditEventSource`'s `ext.<manifest.name>.` derivation (minus the trailing dot,
 * since this is a namespace value stored alongside `key`, not a string prefix concatenated onto
 * it). */
export function extensionNamespaceFor(manifestName: string): string {
  return `ext.${manifestName}`
}

export function validateTtl(ttlSeconds: number): void {
  if (!(ttlSeconds > 0 && ttlSeconds <= MAX_TTL_SECONDS)) {
    throw new EphemeralStateValidationError(
      `ephemeralState: ttlSeconds must be in (0, ${MAX_TTL_SECONDS}], got ${ttlSeconds}`
    )
  }
}

export function validateKeySize(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new EphemeralStateValidationError(
      `ephemeralState: key exceeds ${MAX_KEY_LENGTH} characters`
    )
  }
}

export function validateValueSize(value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new EphemeralStateValidationError(
      `ephemeralState: value exceeds ${MAX_VALUE_BYTES} bytes`
    )
  }
}

function requireOrgId(): string {
  const context = getRequestContext()
  if (!context) throw new EphemeralStateUnboundContextError()
  return context.orgId
}

function serializeEncryptedValue(value: EncryptedValue): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function deserializeEncryptedValue(buffer: Buffer): EncryptedValue {
  return JSON.parse(buffer.toString('utf8')) as EncryptedValue
}

async function decryptStoredValue(ciphertext: Buffer): Promise<string> {
  const plaintext = await withSecret(deserializeEncryptedValue(ciphertext), async (buf) =>
    buf.toString('utf8')
  )
  return plaintext
}

function rowMatch(namespace: string, key: string) {
  return and(
    eq(extensionEphemeralState.extensionNamespace, namespace),
    eq(extensionEphemeralState.key, key)
  )
}

type ExistingRow = { id: string; isLive: boolean }

/**
 * Locks the candidate row (`SELECT ... FOR UPDATE`) so a concurrent transaction cannot delete or
 * expire-and-revive it out from under our overwrite-vs-count-increasing decision (closes a TOCTOU
 * race the earlier unlocked-`SELECT` version had between this check and the final upsert), and
 * determines liveness via Postgres's own `now()` rather than the app server's clock — the same
 * clock the `setWhere: expires_at <= now()` revival guard uses — so the two can never disagree
 * under app/DB clock skew.
 */
async function selectExistingRowForUpdate(
  tx: Tx,
  namespace: string,
  key: string
): Promise<ExistingRow | undefined> {
  const rows = await tx
    .select({
      id: extensionEphemeralState.id,
      isLive: sql<boolean>`${extensionEphemeralState.expiresAt} > now()`,
    })
    .from(extensionEphemeralState)
    .where(rowMatch(namespace, key))
    .for('update')
  return rows[0]
}

/**
 * AC-11 — guards a count-increasing write (a brand-new key, or reviving an already-expired one)
 * with the per-org advisory lock before evaluating the live-count cap. A plain overwrite of an
 * already-live key never reaches the lock/cap check at all (cap gates only count-increasing
 * writes). Must run inside the same `tx` as the write it guards (Pre-mortem Finding).
 */
async function ensureCapacityForCountIncreasingWrite(
  tx: Tx,
  orgId: string,
  namespace: string,
  key: string
): Promise<void> {
  const existing = await selectExistingRowForUpdate(tx, namespace, key)
  if (existing?.isLive) return // overwrite of an already-live key — never count-increasing

  // AC-11 — pg_advisory_xact_lock, same call shape as external-service.ts's
  // 'external-share-cap:' lock: serializes concurrent count-increasing writes for this org so two
  // concurrent creates at 999 live entries never both succeed.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('extension-ephemeral-state-cap:' || ${orgId}, 0))`
  )

  // Re-check under the lock: a concurrent transaction may have created/revived this same key
  // between our pre-check above and acquiring the lock.
  const recheck = await selectExistingRowForUpdate(tx, namespace, key)
  if (recheck?.isLive) return

  const countRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(extensionEphemeralState)
    .where(
      and(
        eq(extensionEphemeralState.orgId, orgId),
        sql`${extensionEphemeralState.expiresAt} > now()`
      )
    )
  const liveCount = Number(countRows[0]?.count ?? 0)
  if (liveCount >= MAX_LIVE_ENTRIES_PER_ORG) {
    throw new EphemeralStateCapExceededError()
  }
}

/** Shared by `set()` and `compareAndSwap(key, null, ...)` — both upsert a row via
 * `INSERT ... ON CONFLICT (org_id, extension_namespace, key) DO UPDATE`. `setWhere`, when given,
 * guards the update so it only fires against an existing-but-expired row (the create-if-absent
 * semantics `compareAndSwap`'s null-`expectedValue` branch needs); omitted, the upsert always
 * applies (`set()`'s unconditional-overwrite semantics). Returns the ids actually
 * inserted/updated — empty when a `setWhere` guard skipped the conflict branch. */
async function upsertEphemeralStateRow(
  tx: Tx,
  params: {
    orgId: string
    namespace: string
    key: string
    ciphertext: Buffer
    keyVersion: number
    expiresAt: Date
    setWhere?: ReturnType<typeof sql>
  }
): Promise<{ id: string }[]> {
  const values = {
    orgId: params.orgId,
    extensionNamespace: params.namespace,
    key: params.key,
    valueCiphertext: params.ciphertext,
    encryptionKeyVersion: params.keyVersion,
    expiresAt: params.expiresAt,
  }
  return tx
    .insert(extensionEphemeralState)
    .values(values)
    .onConflictDoUpdate({
      target: [
        extensionEphemeralState.orgId,
        extensionEphemeralState.extensionNamespace,
        extensionEphemeralState.key,
      ],
      set: {
        valueCiphertext: params.ciphertext,
        encryptionKeyVersion: params.keyVersion,
        expiresAt: params.expiresAt,
        updatedAt: sql`now()`,
      },
      ...(params.setWhere ? { setWhere: params.setWhere } : {}),
    })
    .returning({ id: extensionEphemeralState.id })
}

/** Shared by `compareAndSwap(key, expectedValue, ...)`'s non-null branch and
 * `compareAndDelete()` — both need to lock the candidate row (`SELECT ... FOR UPDATE`, holding
 * the lock for the rest of the transaction per the Pre-mortem Finding), treat an expired row as
 * absent, and decrypt-compare against `expectedValue`. Returns the row's `id` only when it
 * exists, is live, and its decrypted value strictly equals `expectedValue` — `undefined`
 * otherwise (the caller's "false" case). */
async function loadMatchingLiveRowForUpdate(
  tx: Tx,
  namespace: string,
  key: string,
  expectedValue: string
): Promise<string | undefined> {
  const rows = await tx
    .select({
      id: extensionEphemeralState.id,
      valueCiphertext: extensionEphemeralState.valueCiphertext,
      expiresAt: extensionEphemeralState.expiresAt,
    })
    .from(extensionEphemeralState)
    .where(rowMatch(namespace, key))
    .for('update')
  const row = rows[0]
  if (!row) return undefined
  if (row.expiresAt.getTime() <= Date.now()) return undefined // expired counts as absent
  const currentValue = await decryptStoredValue(row.valueCiphertext)
  if (currentValue !== expectedValue) return undefined
  return row.id
}

function isKnownEphemeralStateError(error: unknown): boolean {
  return (
    error instanceof EphemeralStateValidationError ||
    error instanceof EphemeralStateUnboundContextError ||
    error instanceof EphemeralStateCapExceededError
  )
}

/** AC-8 — wraps the DB-touching body of every method: an unexpected store/query failure is
 * logged once at `error` level with `{ extensionNamespace, orgId }` only (never key/value), then
 * re-thrown as a sanitized `EphemeralStateStoreUnavailableError` so no raw driver error text
 * crosses the extension boundary. A known, already-typed rejection (validation/cap/unbound-
 * context) passes through unlogged and unwrapped — those are expected outcomes, not operational
 * anomalies. */
async function withFailClosedLogging<T>(
  logger: Pick<FastifyBaseLogger, 'error'> | undefined,
  extensionNamespace: string,
  orgId: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (isKnownEphemeralStateError(error)) throw error
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.EXTENSION_EPHEMERAL_STATE_FAILED,
        'ephemeralState operation failed',
        { extensionNamespace, orgId }
      )
    }
    throw new EphemeralStateStoreUnavailableError()
  }
}

/**
 * Story 20.8 — constructs the bound `EphemeralStateHost` for one loaded extension. Called once
 * at extension-load time by `buildHostServices()` (mirrors `auditEventSource`/`orgAuthorization`)
 * — every returned method reads `getRequestContext()` internally at call time for the current
 * request's `orgId`, rather than being reconstructed per request.
 */
export function createEphemeralStateHost(
  manifestName: string,
  logger?: Pick<FastifyBaseLogger, 'error'>
): EphemeralStateHost {
  const namespace = extensionNamespaceFor(manifestName)

  return {
    async set(key, value, ttlSeconds) {
      validateKeySize(key)
      validateValueSize(value)
      validateTtl(ttlSeconds)
      const orgId = requireOrgId()
      await withFailClosedLogging(logger, namespace, orgId, async () => {
        const encrypted = await encryptValue(value)
        const ciphertext = serializeEncryptedValue(encrypted)
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
        await withOrg(orgId, async (tx) => {
          await ensureCapacityForCountIncreasingWrite(tx, orgId, namespace, key)
          const keyVersion = await currentKeyVersion(tx)
          await upsertEphemeralStateRow(tx, {
            orgId,
            namespace,
            key,
            ciphertext,
            keyVersion,
            expiresAt,
          })
        })
      })
    },

    async get(key) {
      const orgId = requireOrgId()
      return withFailClosedLogging(logger, namespace, orgId, async () =>
        withOrg(orgId, async (tx) => {
          const rows = await tx
            .select({ valueCiphertext: extensionEphemeralState.valueCiphertext })
            .from(extensionEphemeralState)
            .where(and(rowMatch(namespace, key), sql`${extensionEphemeralState.expiresAt} > now()`))
            .limit(1)
          const row = rows[0]
          if (!row) return undefined
          return decryptStoredValue(row.valueCiphertext)
        })
      )
    },

    async delete(key) {
      const orgId = requireOrgId()
      await withFailClosedLogging(logger, namespace, orgId, async () =>
        withOrg(orgId, async (tx) => {
          await tx.delete(extensionEphemeralState).where(rowMatch(namespace, key))
        })
      )
    },

    async compareAndSwap(key, expectedValue, newValue, ttlSeconds) {
      validateKeySize(key)
      validateValueSize(newValue)
      validateTtl(ttlSeconds)
      const orgId = requireOrgId()
      return withFailClosedLogging(logger, namespace, orgId, async () => {
        const encrypted = await encryptValue(newValue)
        const ciphertext = serializeEncryptedValue(encrypted)
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

        return withOrg(orgId, async (tx) => {
          if (expectedValue === null) {
            // Dev Notes "Implementation Note" — the unique constraint (not a row lock) is the
            // source of atomicity for the create-if-absent path. The `setWhere` guard treats an
            // existing-but-expired row as logically absent (revival succeeds); an existing LIVE
            // row causes the conditional update to no-op, so RETURNING yields no row (false).
            await ensureCapacityForCountIncreasingWrite(tx, orgId, namespace, key)
            const keyVersion = await currentKeyVersion(tx)
            const result = await upsertEphemeralStateRow(tx, {
              orgId,
              namespace,
              key,
              ciphertext,
              keyVersion,
              expiresAt,
              setWhere: sql`${extensionEphemeralState.expiresAt} <= now()`,
            })
            return result.length > 0
          }

          // Pre-mortem Finding — the row lock (SELECT ... FOR UPDATE inside
          // loadMatchingLiveRowForUpdate) and this follow-up UPDATE run inside this one `tx`
          // callback so the lock is held for the whole critical section.
          const matchedId = await loadMatchingLiveRowForUpdate(tx, namespace, key, expectedValue)
          if (!matchedId) return false

          const keyVersion = await currentKeyVersion(tx)
          await tx
            .update(extensionEphemeralState)
            .set({
              valueCiphertext: ciphertext,
              encryptionKeyVersion: keyVersion,
              expiresAt,
              updatedAt: sql`now()`,
            })
            .where(eq(extensionEphemeralState.id, matchedId))
          return true
        })
      })
    },

    async compareAndDelete(key, expectedValue) {
      const orgId = requireOrgId()
      return withFailClosedLogging(logger, namespace, orgId, async () =>
        withOrg(orgId, async (tx) => {
          const matchedId = await loadMatchingLiveRowForUpdate(tx, namespace, key, expectedValue)
          if (!matchedId) return false

          await tx.delete(extensionEphemeralState).where(eq(extensionEphemeralState.id, matchedId))
          return true
        })
      )
    },
  }
}
