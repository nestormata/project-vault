import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { OperationalEvent, PlatformAuditAction } from '@project-vault/shared'
import { getDb } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import type { BossService } from '../../lib/boss.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import {
  secureRoute,
  type SecureRouteContext,
  type PublicRouteContext,
} from '../../lib/secure-route.js'
import {
  writePlatformAuditEntryOrFailClosed,
  SameTransactionPlatformAuditWriteError,
} from '../../lib/audit-or-fail-closed.js'
import { operationalLog, serializeLogError } from '../../lib/logger.js'
import { isBackupEnabled } from './config.js'
import {
  acquireBackupSlot,
  listBackups,
  releaseBackupSlotOnAuditFailure,
  restoreFromBackup,
  updateBackupVerifiedStatus,
  validateBackupFile,
  type RestoreOutcome,
} from './service.js'
import { createAdminAlert, deliverAdminAlertAcrossOrgs } from './alerts.js'
import {
  BackupAlreadyRunningErrorSchema,
  BackupChecksumMismatchErrorSchema,
  BackupConfirmationRequiredErrorSchema,
  BackupDecryptFailedErrorSchema,
  BackupFilenameParamsSchema,
  BackupListResponseSchema,
  BackupNotConfiguredErrorSchema,
  BackupNotFoundErrorSchema,
  BackupRestoreBodySchema,
  BackupRestoreResponseSchema,
  BackupTriggerResponseSchema,
  BackupValidateResponseSchema,
  VaultSealedResponseSchema,
} from './schema.js'

type BossFastify = FastifyApp & { boss?: BossService }

const BACKUP_NOT_CONFIGURED_ERROR = {
  code: 'backup_not_configured',
  message:
    'Backup is not configured on this instance. Set BACKUP_STORAGE_PATH or BACKUP_S3_BUCKET.',
} as const

const PLATFORM_AUDIT_WRITE_FAILED_ERROR = {
  code: 'platform_audit_write_failed',
  message: 'Platform audit logging is unavailable',
} as const

/**
 * Story 9.4 AC-7/D7: these four routes have no `secureCtx.tx` (requireOrgScope: false, D2) to
 * share a literal DB transaction with the platform-audit write the way single-transaction
 * operations (settings/orgs, AC-8) do — `restoreFromBackup`'s `pg_restore` step in particular is
 * long-running and non-transactional by nature. Each retrofitted write runs in its own dedicated
 * transaction; a failure (maintenance mode inactive) is surfaced as 503 so the operator is told
 * their action's audit record did not land, matching AC-6's fail-closed invariant as closely as
 * this route shape allows.
 */
async function writeBackupPlatformAudit(
  reply: FastifyReply,
  input: Parameters<typeof writePlatformAuditEntryOrFailClosed>[1]
): Promise<boolean> {
  try {
    await getDb().transaction((tx) => writePlatformAuditEntryOrFailClosed(tx, input))
    return true
  } catch (error) {
    if (error instanceof SameTransactionPlatformAuditWriteError) {
      reply.status(503).send(PLATFORM_AUDIT_WRITE_FAILED_ERROR)
      return false
    }
    throw error
  }
}

/** Story 9.4 AC-7 edge case: the `backup.restore_failed` follow-up write never overrides the
 * route's own 500 response — the restore has already definitively failed by the time this runs,
 * so the reply must stay authoritative regardless of whether this best-effort audit write itself
 * also succeeds. Never touches `reply`. */
async function writeBackupPlatformAuditBestEffort(
  input: Parameters<typeof writePlatformAuditEntryOrFailClosed>[1]
): Promise<void> {
  try {
    await getDb().transaction((tx) => writePlatformAuditEntryOrFailClosed(tx, input))
  } catch (error) {
    if (!(error instanceof SameTransactionPlatformAuditWriteError)) throw error
  }
}

/** Split out of the restore route's handler purely to keep its cyclomatic complexity within this
 * repo's eslint threshold (Story 9.4 added a platform-audit write to the `restored` branch,
 * pushing the inline handler over the limit) — same discipline `service.ts`'s own
 * `restoreFromBackup` already documents for the identical reason. */
async function handleRestoreOutcome(input: {
  outcome: RestoreOutcome
  filename: string
  operatorId: string
  restoreStart: number
  req: FastifyRequest
  reply: FastifyReply
}): Promise<unknown> {
  const { outcome, filename, operatorId, restoreStart, req, reply } = input
  switch (outcome.code) {
    case 'not_found':
      return reply
        .status(404)
        .send({ code: 'backup_not_found', message: 'No backup found with that filename.' })
    case 'checksum_mismatch':
      return reply.status(422).send({
        code: 'backup_checksum_mismatch',
        message:
          'Stored checksum does not match the backup file — refusing to restore a potentially corrupted or tampered backup.',
      })
    case 'decrypt_failed':
      return reply.status(401).send({
        code: 'backup_decrypt_failed',
        message: 'Backup could not be decrypted with the current master key.',
      })
    case 'restore_failed':
      // Code review fix: the pg_restore/psql subprocess (or a racing concurrent
      // restore/zeroKeys) failed after checksum verification passed — previously this threw
      // uncaught with no operational-log trace (AC-18 gap). Sanitized message only; the raw
      // stderr tail stays server-side in the log, never in the HTTP response.
      operationalLog(
        req.log,
        'error',
        OperationalEvent.BACKUP_RESTORE_FAILED,
        'backup restore failed',
        {
          filename,
          errorMessage: outcome.message,
        }
      )
      // AC-7 edge case: the table is append-only — this does NOT retroactively rewrite the
      // `_initiated` row above; an operator reviewing the log sees both rows and can
      // reconstruct the timeline. Best-effort: the restore has already definitively failed,
      // so a 500 (not 503) is the correct response regardless of whether this follow-up audit
      // write itself also succeeds.
      await writeBackupPlatformAuditBestEffort({
        operatorId,
        actionType: PlatformAuditAction.BACKUP_RESTORE_FAILED,
        payload: { filename, errorMessage: outcome.message },
        request: req,
      })
      return reply.status(500).send({
        code: 'backup_restore_failed',
        message: 'Restore failed unexpectedly. See server logs for details.',
      })
    case 'restored': {
      operationalLog(
        req.log,
        'warn',
        OperationalEvent.BACKUP_RESTORE_COMPLETED,
        'backup restore completed',
        { filename, durationMs: Date.now() - restoreStart }
      )
      // Code review fix: pg_restore has already irreversibly completed and the vault has
      // already been resealed (`sealedAfterRestore`) by this point — same reasoning as the
      // `restore_failed` case above (the reply must stay authoritative regardless of whether
      // this best-effort audit write itself also succeeds). Previously used the fail-closed
      // wrapper, which could tell an operator their successful restore "failed" with a 503 even
      // though it had already completed, with no way for the client to learn it actually
      // succeeded.
      await writeBackupPlatformAuditBestEffort({
        operatorId,
        actionType: PlatformAuditAction.BACKUP_RESTORE_COMPLETED,
        payload: { filename },
        request: req,
      })
      return {
        data: { restored: true as const, filename, sealedAfterRestore: true as const },
      }
    }
  }
}

/**
 * Story 9.1 D1/AC-1/AC-7/AC-8/AC-9/AC-10/AC-16: all four backup/restore routes are instance-wide
 * (not org-scoped, D2) — `requireOrgScope: false` paired with the new, explicit
 * `requirePlatformOperator: true` flag (architecture.md's "concerns opted out explicitly with
 * named flags" principle). `writeAuditEvent: false` because these routes have no
 * `secureCtx.tx` to write an org-scoped audit_log_entries row through in the first place (D6) —
 * backup/restore actions are logged via structured operational logging instead (D6, AC-18). The
 * sealed-vault guard (Story 1.5, AC-16) applies automatically to every one of these routes with
 * zero additional code — they are deliberately NOT added to any allow-list.
 */
export async function backupRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/backup/trigger',
    schema: {
      response: {
        202: BackupTriggerResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        409: BackupAlreadyRunningErrorSchema,
        503: z.union([BackupNotConfiguredErrorSchema, VaultSealedResponseSchema, ApiErrorSchema]),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      writeAuditEvent: false,
      rateLimit: { max: 10, timeWindowMs: 60_000, key: 'POST /api/v1/admin/backup/trigger' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext

      if (!isBackupEnabled()) {
        return reply.status(503).send(BACKUP_NOT_CONFIGURED_ERROR)
      }

      const slot = await acquireBackupSlot({
        triggeredBy: 'manual',
        triggeredByUserId: secureCtx.auth.userId,
      })
      if (!slot.ok) {
        return reply.status(409).send({
          code: 'backup_already_running',
          message: `A backup is already in progress${slot.runningSince ? ` (started at ${slot.runningSince})` : ''}.`,
          jobId: slot.jobId,
        })
      }

      operationalLog(req.log, 'info', OperationalEvent.BACKUP_TRIGGERED, 'backup triggered', {
        userId: secureCtx.auth.userId,
        filename: slot.filename,
        triggeredBy: 'manual',
      })

      // Story 9.4 AC-7: platform_audit_events retrofit — recorded right alongside the
      // operational log above.
      const auditOk = await writeBackupPlatformAudit(reply, {
        operatorId: secureCtx.auth.userId,
        actionType: PlatformAuditAction.BACKUP_TRIGGERED,
        payload: { jobId: slot.runId },
        request: req,
      })
      if (!auditOk) {
        // Code review fix: `acquireBackupSlot()` already committed its own transaction and
        // inserted the `status: 'running'` concurrency-marker row above — without releasing it
        // here, this audit-write failure would otherwise strand that row at `running` forever
        // (nothing else un-sticks it except a full process restart), permanently 409-ing every
        // future trigger. See `releaseBackupSlotOnAuditFailure`'s own doc comment.
        await releaseBackupSlotOnAuditFailure(slot.runId)
        return reply
      }

      const boss = (fastify as BossFastify).boss
      if (boss) {
        await boss.send(
          'backup/snapshot',
          { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
          { singletonKey: `backup/snapshot/${slot.runId}` }
        )
      }

      reply.status(202)
      return { data: { jobId: slot.runId, status: 'running' as const } }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/backups',
    schema: {
      response: {
        200: BackupListResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/admin/backups' },
    },
    handler: async (_ctx: SecureRouteContext | PublicRouteContext) => {
      const items = await listBackups()
      return { data: { items } }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/backups/:filename/restore',
    schema: {
      response: {
        200: BackupRestoreResponseSchema,
        400: BackupConfirmationRequiredErrorSchema,
        // AC-9: 401 covers both the auth-layer failure (access_token_missing) and
        // backup_decrypt_failed — the latter is not itself an authn failure, but the story's
        // literal AC text specifies 401 for it too, matching Story 1.5's "no oracle" unseal-error
        // discipline (never distinguish "wrong key" from "corrupted ciphertext" in the response).
        401: z.union([ApiErrorSchema, BackupDecryptFailedErrorSchema]),
        403: ApiErrorSchema,
        404: BackupNotFoundErrorSchema,
        422: BackupChecksumMismatchErrorSchema,
        // Code review fix: pg_restore/psql subprocess failure after checksum verification passed
        // — an unexpected but possible outcome that previously had no declared response shape.
        500: ApiErrorSchema,
        // Story 9.4 AC-7/AC-20: platform-audit write failure before the restore is even attempted.
        // VaultSealedResponseSchema is included too — vaultGuard's own onRequest hook (which fires
        // before this route's handler ever runs) sends its `{status, message}` sealed-vault body
        // through this route's compiled 503 serializer; omitting it here caused a silent
        // serialization failure (opaque 500) the one time the vault is sealed AND this status
        // code has a declared schema (code review finding, this story).
        503: z.union([ApiErrorSchema, VaultSealedResponseSchema]),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      writeAuditEvent: false,
      rateLimit: {
        max: 5,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/admin/backups/:filename/restore',
      },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const params = parseParams(BackupFilenameParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(BackupRestoreBodySchema, req, reply)
      if (!parsed.success) return reply

      if (!parsed.data.confirmRestore || !parsed.data.reason) {
        return reply.status(400).send({
          code: 'confirmation_required',
          message: 'Restore is destructive. confirmRestore: true and a reason are both required.',
        })
      }

      operationalLog(
        req.log,
        'warn',
        OperationalEvent.BACKUP_RESTORE_INITIATED,
        'backup restore initiated',
        { userId: secureCtx.auth.userId, filename: params.filename, reason: parsed.data.reason }
      )

      // Story 9.4 AC-7: written BEFORE the restore itself runs (a two-phase, non-transactional
      // operation, D7) — if this fails and maintenance mode is inactive, the restore never
      // proceeds at all (AC-6's "100% capture guarantee" applied as strictly as this route shape
      // allows: no destructive action without at least its initiation being recorded).
      const initiatedOk = await writeBackupPlatformAudit(reply, {
        operatorId: secureCtx.auth.userId,
        actionType: PlatformAuditAction.BACKUP_RESTORE_INITIATED,
        payload: { filename: params.filename, reason: parsed.data.reason },
        request: req,
      })
      if (!initiatedOk) return reply

      const restoreStart = Date.now()
      const outcome = await restoreFromBackup(params.filename)

      return handleRestoreOutcome({
        outcome,
        filename: params.filename,
        operatorId: secureCtx.auth.userId,
        restoreStart,
        req,
        reply,
      })
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/backups/:filename/validate',
    schema: {
      response: {
        200: BackupValidateResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        // Story 9.4 AC-7: platform-audit write failure. VaultSealedResponseSchema included for
        // the same reason as the restore route above (vaultGuard's own sealed-vault body must
        // still satisfy this route's compiled 503 serializer).
        503: z.union([ApiErrorSchema, VaultSealedResponseSchema]),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      writeAuditEvent: false,
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/admin/backups/:filename/validate',
      },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const params = parseParams(BackupFilenameParamsSchema, req, reply)
      if (!params) return reply

      operationalLog(
        req.log,
        'info',
        OperationalEvent.BACKUP_VALIDATE_INITIATED,
        'backup validate initiated',
        { userId: secureCtx.auth.userId, filename: params.filename }
      )

      const outcome = await validateBackupFile(params.filename)
      await updateBackupVerifiedStatus(params.filename, outcome.valid ? 'valid' : 'invalid')

      operationalLog(
        req.log,
        'info',
        OperationalEvent.BACKUP_VALIDATE_COMPLETED,
        'backup validate completed',
        { filename: params.filename, valid: outcome.valid }
      )

      // Code review fix: validation (and its `backup_runs.verified` side effect) has already run
      // by this point — a non-destructive, re-computable action, but still already-taken-effect.
      // Same best-effort reasoning as the restore outcomes above: don't tell the operator a
      // completed validation "failed" just because the audit write itself hiccuped.
      await writeBackupPlatformAuditBestEffort({
        operatorId: secureCtx.auth.userId,
        actionType: PlatformAuditAction.BACKUP_VALIDATED,
        payload: { filename: params.filename, valid: outcome.valid },
        request: req,
      })

      return {
        data: {
          valid: outcome.valid,
          assetsPresent: outcome.assetsPresent,
          checksum: outcome.checksumMatches ? ('match' as const) : ('mismatch' as const),
        },
      }
    },
  })
}

/** D6/AC-13: called by the backup/snapshot worker on failure — kept here (not in service.ts,
 * which intentionally has no notification/boss dependency) since it composes the alert +
 * delivery + operational-log concerns the route layer already imports. */
export async function reportBackupFailureAlert(
  boss: BossService,
  logger: Parameters<typeof operationalLog>[0],
  input: { filename: string; errorMessage: string; reason?: string }
): Promise<void> {
  operationalLog(logger, 'error', OperationalEvent.BACKUP_FAILED, 'backup failed', {
    filename: input.filename,
    errorMessage: input.errorMessage,
    ...(input.reason ? { reason: input.reason } : {}),
    err: serializeLogError(new Error(input.errorMessage)),
  })
  await createAdminAlert({
    alertType: 'backup.failure',
    severity: 'critical',
    payload: {
      filename: input.filename,
      errorMessage: input.errorMessage,
      alertInstanceId: randomUUID(),
    },
  })
  // AC-13: delivery-side spam across repeated failures is handled by the existing
  // notification-preferences digest/dedup logic (Story 3.2), not by suppressing the row.
  await deliverAdminAlertAcrossOrgs(boss, 'backup.failure', {
    filename: input.filename,
    errorMessage: input.errorMessage,
  })
}
