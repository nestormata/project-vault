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
import { SameTransactionAuditWriteError } from './secure-route.js'

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

export type PlatformAuditInput = PlatformAuditFields & { request?: FastifyRequest }

/**
 * Story 9.4 AC-6/D8: writes a same-transaction platform-audit row and fails closed — UNLESS
 * maintenance mode is active (D8/AC-15), in which case a write failure is caught and queued to
 * `platform_audit_pending_entries` instead of aborting the parent transaction. Also opportunistically
 * drains any queued entries after every ordinary successful write (AC-16) — best-effort: a drain
 * failure must never take down the (already-succeeded) triggering action's transaction, so it is
 * swallowed rather than rethrown.
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
    // `auth/service.ts`'s `allocateOrganizationSlug`). AC-6 explicitly lists a genuine DB
    // constraint violation (not just a sealed-vault `VaultSealedError`) as a failure this
    // mechanism must handle — without the savepoint, a real Postgres-level error here would
    // abort the entire outer `tx`, so the very next statement (`isMaintenanceModeActive(tx)`
    // below) would itself throw "current transaction is aborted", silently defeating the
    // maintenance-mode fallback exactly when it's needed most.
    await tx.transaction((savepointTx) =>
      writePlatformAuditEntry(savepointTx as Tx, resolvedFields)
    )
  } catch (error) {
    if (await isMaintenanceModeActive(tx)) {
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
    throw new SameTransactionPlatformAuditWriteError(
      error instanceof Error ? error.message : String(error)
    )
  }

  // AC-16: opportunistic drain — never let a drain failure roll back the write that just
  // succeeded above.
  try {
    await drainPendingEntries(tx, resolvedFields.operatorId, { skipLocked: true })
  } catch {
    // Best-effort: the next successful write will retry the drain.
  }
}
