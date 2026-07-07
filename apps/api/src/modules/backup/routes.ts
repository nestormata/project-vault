import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import type { BossService } from '../../lib/boss.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import {
  secureRoute,
  type SecureRouteContext,
  type PublicRouteContext,
} from '../../lib/secure-route.js'
import { operationalLog, serializeLogError } from '../../lib/logger.js'
import { isBackupEnabled } from './config.js'
import {
  acquireBackupSlot,
  listBackups,
  restoreFromBackup,
  updateBackupVerifiedStatus,
  validateBackupFile,
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
        503: z.union([BackupNotConfiguredErrorSchema, VaultSealedResponseSchema]),
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

      const boss = (fastify as BossFastify).boss
      if (boss) {
        await boss.send(
          'backup:snapshot',
          { runId: slot.runId, filename: slot.filename, metaFilename: slot.metaFilename },
          { singletonKey: `backup:snapshot:${slot.runId}` }
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
      const restoreStart = Date.now()

      const outcome = await restoreFromBackup(params.filename)

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
        case 'restored':
          operationalLog(
            req.log,
            'warn',
            OperationalEvent.BACKUP_RESTORE_COMPLETED,
            'backup restore completed',
            { filename: params.filename, durationMs: Date.now() - restoreStart }
          )
          return {
            data: {
              restored: true as const,
              filename: params.filename,
              sealedAfterRestore: true as const,
            },
          }
      }
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

/** D6/AC-13: called by the backup:snapshot worker on failure — kept here (not in service.ts,
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
