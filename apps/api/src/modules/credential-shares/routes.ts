import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { roleRank, secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import type { BossService } from '../../lib/boss.js'
import {
  rejectIfInsufficientProjectRoleForReveal,
  rejectIfProjectNotVisible,
} from '../credentials/routes.js'
import { credentialExistsInProject } from '../credentials/db-helpers.js'
import {
  dispatchDirectUserNotification,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../../notifications/dispatcher.js'
import {
  CreateCredentialShareBodySchema,
  CreateCredentialShareResponseSchema,
  CredentialShareParamsSchema,
  CredentialShareRevokeParamsSchema,
  ListCredentialSharesResponseSchema,
  RevokeCredentialShareResponseSchema,
  type CreateCredentialShareBody,
} from './schema.js'
import {
  createCredentialShare,
  listSharesCreatedByUser,
  revokeShare,
  type CredentialShareRow,
} from './service.js'

const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const
const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const SHARE_NOT_FOUND = { code: 'share_not_found', message: 'Share not found' } as const

function serializeShare(share: CredentialShareRow) {
  return {
    id: share.id,
    credentialId: share.credentialId,
    fieldKey: share.fieldKey,
    sharedBy: share.sharedBy,
    recipientUserId: share.recipientUserId,
    singleUse: share.singleUse,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt.toISOString(),
    revokedAt: share.revokedAt?.toISOString() ?? null,
    firstViewedAt: share.firstViewedAt?.toISOString() ?? null,
    viewCount: share.viewCount,
    status: share.status,
  }
}

function writeShareAuditEntry(
  tx: SecureRouteContext['tx'],
  auth: SecureRouteContext['auth'],
  req: FastifyRequest,
  input: { eventType: string; resourceId: string; payload: Record<string, unknown> }
): Promise<void> {
  return writeHumanAuditEntryOrFailClosed(tx, {
    orgId: auth.orgId,
    actorUserId: auth.userId,
    resourceType: 'credential_share',
    request: req,
    ...input,
  })
}

function createShareErrorResponse(
  reply: FastifyReply,
  result: Exclude<Awaited<ReturnType<typeof createCredentialShare>>, { status: 'ok' }>
): unknown {
  if (result.status === 'credential_not_found') {
    return reply.status(404).send(CREDENTIAL_NOT_FOUND)
  }
  if (result.status === 'self_share') {
    return reply
      .status(400)
      .send({ code: 'self_share', message: 'You cannot share with yourself.' })
  }
  if (result.status === 'recipient_not_found') {
    return reply
      .status(400)
      .send({ code: 'recipient_not_found', message: 'Recipient must be a member of this org.' })
  }
  if (result.status === 'recipient_inactive') {
    return reply
      .status(400)
      .send({ code: 'recipient_inactive', message: 'Recipient is a deactivated org user.' })
  }
  if (result.status === 'unknown_field_key') {
    return reply.status(400).send({
      code: 'unknown_field_key',
      message: `Unknown field key: '${result.field}'`,
      field: result.field,
    })
  }
  return reply.status(400).send({
    code: 'expires_at_invalid',
    message:
      result.reason === 'past'
        ? 'expiresAt must be in the future.'
        : 'expiresAt exceeds the maximum allowed share duration.',
  })
}

type BossFastify = FastifyApp & { boss?: BossService }

/** Post-commit, best-effort notification dispatch — identical pattern to
 *  apps/api/src/modules/rotation/routes.ts's sendPendingRotationNotifications. A missed
 *  boss.send() is safe: the notification_queue row is already durable and the catch-up cron will
 *  pick it up (AC-18: never blocks/rolls back the share that was just successfully created). */
async function sendPendingShareNotifications(
  fastify: FastifyApp,
  request: { log: { warn: (payload: unknown, msg: string) => void } },
  jobs: NotificationQueueJob[]
): Promise<void> {
  const boss = (fastify as BossFastify).boss
  if (!boss || jobs.length === 0) return
  try {
    await sendNotificationJobs(boss, jobs)
  } catch (error) {
    request.log.warn({ err: error }, 'credential share notification dispatch failed')
  }
}

export async function credentialSharesRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/shares',
    schema: {
      response: {
        201: CreateCredentialShareResponseSchema,
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/shares',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialShareParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<CreateCredentialShareBody>(
        CreateCredentialShareBodySchema,
        req,
        reply
      )
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (
        await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId, PROJECT_NOT_FOUND)
      ) {
        return reply
      }

      // AC-1: share-creation eligibility reuses reveal's exact permission gate — never a second,
      // parallel check that could drift out of sync with reveal's rules.
      if (
        await rejectIfInsufficientProjectRoleForReveal(
          secureCtx,
          req,
          reply,
          params.projectId,
          params.credentialId,
          'reveal'
        )
      ) {
        return reply
      }

      const result = await createCredentialShare(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        credentialId: params.credentialId,
        sharedByUserId: secureCtx.auth.userId,
        recipientUserId: parsed.data.recipientUserId,
        fieldKey: parsed.data.fieldKey,
        expiresAt: new Date(parsed.data.expiresAt),
        singleUse: parsed.data.singleUse,
      })
      if (result.status !== 'ok') return createShareErrorResponse(reply, result)

      try {
        await writeShareAuditEntry(secureCtx.tx, secureCtx.auth, req, {
          eventType: AuditEvent.CREDENTIAL_SHARE_CREATED,
          resourceId: result.share.id,
          payload: {
            credentialId: params.credentialId,
            projectId: params.projectId,
            recipientUserId: parsed.data.recipientUserId,
            fieldKey: result.share.fieldKey,
            singleUse: result.share.singleUse,
            expiresAt: result.share.expiresAt.toISOString(),
          },
        })
      } catch (error) {
        req.log.error(
          { eventType: 'credential_share.audit_failed', credentialId: params.credentialId },
          'Credential share audit write failed — transaction will roll back'
        )
        throw error
      }

      // AC-18: best-effort — a notification-dispatch failure never blocks or rolls back share
      // creation. The one-time link display to the sharer is the guaranteed fallback.
      let jobs: NotificationQueueJob[] = []
      try {
        jobs = await dispatchDirectUserNotification({
          orgId: secureCtx.auth.orgId,
          userId: parsed.data.recipientUserId,
          template: {
            templateId: 'credential.share_created',
            payload: {
              shareId: result.share.id,
              credentialId: params.credentialId,
              sharedByUserId: secureCtx.auth.userId,
              fieldKey: result.share.fieldKey,
            },
            severity: 'info',
          },
          tx: secureCtx.tx,
        })
      } catch (error) {
        req.log.warn(
          {
            eventType: 'credential_share.notification_failed',
            shareId: result.share.id,
            err: error,
          },
          'Credential share notification dispatch failed — share was still created'
        )
      }

      reply.status(201)
      const response = { data: { ...serializeShare(result.share), token: result.token } }
      await sendPendingShareNotifications(fastify, req, jobs)
      return response
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/shares',
    schema: {
      response: {
        200: ListCredentialSharesResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'member', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialShareParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      if (
        await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId, PROJECT_NOT_FOUND)
      ) {
        return reply
      }
      const exists = await credentialExistsInProject(secureCtx.tx, params)
      if (!exists) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      const shares = await listSharesCreatedByUser(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        sharedByUserId: secureCtx.auth.userId,
      })
      return { data: { items: shares.map(serializeShare) } }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/shares/:shareId/revoke',
    schema: {
      response: {
        200: RevokeCredentialShareResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/shares/:shareId/revoke',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialShareRevokeParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      if (
        await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId, PROJECT_NOT_FOUND)
      ) {
        return reply
      }

      // AC-5: the sharer, or any org admin/owner (reusing the existing
      // admin-can-manage-project-scoped-resources convention).
      const existing = await revokeShare(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        shareId: params.shareId,
      })
      if (existing.status === 'not_found') return reply.status(404).send(SHARE_NOT_FOUND)

      if (
        existing.share.sharedBy !== secureCtx.auth.userId &&
        roleRank(secureCtx.auth.orgRole) < roleRank('admin')
      ) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Only the sharer or an org admin can revoke this share.',
        })
      }

      if (!existing.alreadyTerminal) {
        try {
          await writeShareAuditEntry(secureCtx.tx, secureCtx.auth, req, {
            eventType: AuditEvent.CREDENTIAL_SHARE_REVOKED,
            resourceId: existing.share.id,
            payload: {
              credentialId: params.credentialId,
              projectId: params.projectId,
              reason: 'manual_revoke',
            },
          })
        } catch (error) {
          req.log.error(
            { eventType: 'credential_share.audit_failed', shareId: params.shareId },
            'Credential share revoke audit write failed — transaction will roll back'
          )
          throw error
        }
      }

      return { data: serializeShare(existing.share) }
    },
  })
}
