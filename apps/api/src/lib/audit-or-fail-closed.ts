import type { FastifyRequest } from 'fastify'
import type { Tx } from '@project-vault/db'
import { firstActorTokenIdForUser } from '../modules/audit/actor-token.js'
import { writeHumanAuditEntry } from '../modules/audit/human-entry.js'
import {
  writeMachineAuditEntry,
  writeSystemAuditEntry,
  type SystemAuditFields,
} from '../modules/audit/machine-entry.js'
import {
  writePlatformAuditEntry,
  redactPlatformAuditPayload,
  type PlatformAuditFields,
} from '../modules/platform-audit/write-entry.js'
import {
  isMaintenanceModeActive,
  drainPendingEntries,
  queuePendingEntry,
} from '../modules/platform-audit/maintenance-mode.js'
import { VaultSealedError } from '../modules/vault/key-service.js'
import { SameTransactionAuditWriteError } from './secure-route.js'

// Story 9.8 AC-T1: only these database/socket failures may use the maintenance bypass.
const PLATFORM_AUDIT_STORAGE_SQLSTATE_CLASSES = ['08', '53'] as const
const PLATFORM_AUDIT_STORAGE_SQLSTATES = new Set(['57P01', '57P02', '57P03'])
const POSTGRES_SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/
const PLATFORM_AUDIT_STORAGE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EPIPE',
])

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function isPlatformAuditStorageUnavailableError(error: unknown): boolean {
  if (error instanceof VaultSealedError) return true

  const cause =
    error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined
  return [errorCode(cause), errorCode(error)].some(
    (code) =>
      code !== undefined &&
      ((POSTGRES_SQLSTATE_PATTERN.test(code) &&
        PLATFORM_AUDIT_STORAGE_SQLSTATE_CLASSES.some((prefix) => code.startsWith(prefix))) ||
        PLATFORM_AUDIT_STORAGE_SQLSTATES.has(code) ||
        PLATFORM_AUDIT_STORAGE_SOCKET_CODES.has(code))
  )
}

/** Shared by every `write*AuditEntryOrFailClosed` wrapper below: any audit-write error is
 * rewrapped as `SameTransactionAuditWriteError` so SecureRoute (or a job's own transaction) rolls
 * back and fails closed instead of completing a mutation without an audit record. */
async function rethrowAsSameTransactionAuditWriteError(write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    throw new SameTransactionAuditWriteError(error instanceof Error ? error.message : String(error))
  }
}

export type SameTransactionAuditInput = {
  orgId: string
  actorUserId: string
  eventType: string
  resourceId?: string
  resourceType: string
  payload: Record<string, unknown>
  request: FastifyRequest
}

/**
 * Writes a same-transaction human audit row and fails closed: any audit-write error is
 * rewrapped as SameTransactionAuditWriteError so SecureRoute rolls back the transaction and
 * returns 503 audit_write_failed instead of completing the mutation without an audit record.
 */
export async function writeHumanAuditEntryOrFailClosed(
  tx: Tx,
  input: SameTransactionAuditInput
): Promise<void> {
  await rethrowAsSameTransactionAuditWriteError(async () => {
    const actorTokenId = await firstActorTokenIdForUser(tx, input.actorUserId)
    await writeHumanAuditEntry(tx, {
      orgId: input.orgId,
      actorTokenId,
      eventType: input.eventType,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      payload: input.payload,
      meta: {
        ipAddress: input.request.ip,
        userAgent:
          typeof input.request.headers['user-agent'] === 'string'
            ? input.request.headers['user-agent']
            : null,
      },
    })
  })
}

export type MachineAuditInput = {
  orgId: string
  eventType: string
  resourceId?: string
  resourceType: string
  payload: Record<string, unknown>
  machineUserId: string
  keyId: string
  request: FastifyRequest
}

/**
 * Story 7.2 D5 — same fail-closed/SameTransactionAuditWriteError contract as
 * `writeHumanAuditEntryOrFailClosed`, for machine-originated events (`actorType: 'machine_user'`).
 */
export async function writeMachineAuditEntryOrFailClosed(
  tx: Tx,
  input: MachineAuditInput
): Promise<void> {
  await rethrowAsSameTransactionAuditWriteError(() =>
    writeMachineAuditEntry(tx, {
      orgId: input.orgId,
      eventType: input.eventType,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      payload: input.payload,
      machineUserId: input.machineUserId,
      keyId: input.keyId,
      meta: {
        ipAddress: input.request.ip,
        userAgent:
          typeof input.request.headers['user-agent'] === 'string'
            ? input.request.headers['user-agent']
            : null,
      },
    })
  )
}

/**
 * Story 7.2 D5/AC-18 — same fail-closed contract, for system/job-initiated events
 * (`actorType: 'system'`, e.g. the overlap-window auto-revoke job). No HTTP request exists for
 * these, so there is no IP/user-agent metadata to attach.
 */
export async function writeSystemAuditEntryOrFailClosed(
  tx: Tx,
  input: SystemAuditFields
): Promise<void> {
  await rethrowAsSameTransactionAuditWriteError(() => writeSystemAuditEntry(tx, input))
}

/** Story 9.4 D6: sibling to `SameTransactionAuditWriteError`, same rethrow-and-roll-back
 * contract, for the platform audit log. */
export class SameTransactionPlatformAuditWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SameTransactionPlatformAuditWriteError'
  }
}

function platformAuditWriteError(error: unknown): SameTransactionPlatformAuditWriteError {
  return new SameTransactionPlatformAuditWriteError(
    error instanceof Error ? error.message : String(error)
  )
}

export type PlatformAuditInput = PlatformAuditFields & { request?: FastifyRequest }

/**
 * Story 9.4 AC-6/D8: writes a same-transaction platform-audit row and fails closed — UNLESS
 * a classified storage-unavailability failure occurs while maintenance mode is active (D8/AC-15),
 * in which case it is queued to `platform_audit_pending_entries` instead of aborting the parent
 * transaction. Also opportunistically drains any queued entries after every ordinary successful
 * write (AC-16) — best-effort: a drain failure must never take down the (already-succeeded)
 * triggering action's transaction, so it is swallowed rather than rethrown.
 */
export async function writePlatformAuditEntryOrFailClosed(
  tx: Tx,
  input: PlatformAuditInput
): Promise<void> {
  const { request, ...fields } = input
  const resolvedFields: PlatformAuditFields = {
    ...fields,
    ipAddress: fields.ipAddress ?? request?.ip ?? null,
  }

  try {
    // Code review fix: the write attempt runs in its own SAVEPOINT (`tx.transaction()` nested
    // inside an existing transaction becomes a real SAVEPOINT — same pattern as
    // `auth/service.ts`'s `allocateOrganizationSlug`). Without the savepoint, a Postgres-level
    // error would abort the entire outer `tx`, preventing both the classified-storage fallback
    // and consistent fail-closed wrapping for application/constraint failures.
    await tx.transaction((savepointTx) =>
      writePlatformAuditEntry(savepointTx as Tx, resolvedFields)
    )
  } catch (writeError) {
    try {
      if (
        isPlatformAuditStorageUnavailableError(writeError) &&
        // Serialize the state check and queue insert with deactivation. Otherwise deactivation
        // can commit after this check but before the pending insert, stranding an entry while
        // maintenance mode is inactive and future opportunistic drains are disabled.
        (await isMaintenanceModeActive(tx, { forUpdate: true }))
      ) {
        // Code review fix: `writePlatformAuditEntry` only redacts the payload internally, right
        // before its own (now-aborted) INSERT — the caller here still only has the original,
        // unredacted `resolvedFields.payload`. Without re-redacting before queuing, any write
        // failure while maintenance mode is active (the common case, not just a forbidden-key
        // bug) would persist an unredacted payload into `platform_audit_pending_entries`, which
        // — unlike `platform_audit_events` — has no RLS policy. Redacting here keeps the same
        // guarantee the happy path already has; in non-production this still throws loud on a
        // genuine forbidden-key caller bug rather than silently queuing the secret.
        await queuePendingEntry(tx, {
          ...resolvedFields,
          payload: redactPlatformAuditPayload(resolvedFields.payload, {
            onForbiddenKeyStripped: (message) =>
              process.stderr.write(`[platform-audit] WARN: ${message}\n`),
          }),
        })
        return
      }
    } catch (fallbackError) {
      throw platformAuditWriteError(fallbackError)
    }
    throw platformAuditWriteError(writeError)
  }

  // AC-16: opportunistic drain — never let a drain failure roll back the write that just
  // succeeded above.
  try {
    await drainPendingEntries(tx, resolvedFields.operatorId, { skipLocked: true })
  } catch {
    // Best-effort: the next successful write will retry the drain.
  }
}
