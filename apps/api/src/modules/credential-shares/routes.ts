import type { FastifyReply } from 'fastify'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { roleRank, secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeShareAuditEntry } from './audit.js'
import type { BossService } from '../../lib/boss.js'
import {
  rejectIfInsufficientProjectRoleForReveal,
  rejectIfProjectNotVisible,
} from '../credentials/routes.js'
import { credentialExistsInProject } from '../credentials/db-helpers.js'
import {
  createOrgAdminNotificationEntries,
  dispatchDirectUserNotification,
  dispatchPendingJobs,
  type NotificationQueueJob,
} from '../../notifications/dispatcher.js'
import {
  CreateCredentialShareBodySchema,
  CreateCredentialShareResponseSchema,
  CreateExternalCredentialShareBodySchema,
  CreateExternalCredentialShareResponseSchema,
  CredentialShareParamsSchema,
  CredentialShareRevokeParamsSchema,
  ListCredentialSharesResponseSchema,
  RevokeCredentialShareResponseSchema,
  type CreateCredentialShareBody,
  type CreateExternalCredentialShareBody,
} from './schema.js'
import {
  createCredentialShare,
  findShareInScope,
  listSharesForCredential,
  revokeShare,
  type CredentialShareRow,
} from './service.js'
import {
  createExternalCredentialShare,
  type CreateExternalShareResult,
} from './external-service.js'
import { verifyStepUp } from './step-up.js'

const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const
const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const SHARE_NOT_FOUND = { code: 'share_not_found', message: 'Share not found' } as const
const AUDIT_FAILED_EVENT_TYPE = 'credential_share.audit_failed'

export function serializeShare(share: CredentialShareRow) {
  return {
    id: share.id,
    credentialId: share.credentialId,
    fieldKey: share.fieldKey,
    sharedBy: share.sharedBy,
    recipientType: share.recipientType as 'user' | 'external',
    recipientUserId: share.recipientUserId,
    recipientEmail: share.recipientEmail,
    singleUse: share.singleUse,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt.toISOString(),
    revokedAt: share.revokedAt?.toISOString() ?? null,
    firstViewedAt: share.firstViewedAt?.toISOString() ?? null,
    viewCount: share.viewCount,
    status: share.status,
  }
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

function createExternalShareErrorResponse(
  reply: FastifyReply,
  result: Exclude<CreateExternalShareResult, { status: 'ok' }>
): unknown {
  if (result.status === 'credential_not_found') {
    return reply.status(404).send(CREDENTIAL_NOT_FOUND)
  }
  if (result.status === 'unknown_field_key') {
    return reply.status(400).send({
      code: 'unknown_field_key',
      message: `Unknown field key: '${result.field}'`,
      field: result.field,
    })
  }
  if (result.status === 'cap_exceeded') {
    return reply.status(429).send({
      code: 'external_share_cap_exceeded',
      message:
        'Too many pending external shares for this credential/field. Revoke or wait for one to expire.',
    })
  }
  return reply.status(400).send({
    code: 'expires_at_invalid',
    message:
      result.reason === 'past'
        ? 'expiresAt must be in the future.'
        : 'expiresAt exceeds the maximum allowed external share duration (72h).',
  })
}

type BossFastify = FastifyApp & { boss?: BossService }

/** AC-18: never blocks/rolls back the share that was just successfully created. */
async function sendPendingShareNotifications(
  fastify: FastifyApp,
  request: { log: { warn: (payload: unknown, msg: string) => void } },
  jobs: NotificationQueueJob[]
): Promise<void> {
  await dispatchPendingJobs((fastify as BossFastify).boss, request, jobs, 'credential share')
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
          { eventType: AUDIT_FAILED_EVENT_TYPE, credentialId: params.credentialId },
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
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/external-shares',
    schema: {
      response: {
        201: CreateExternalCredentialShareResponseSchema,
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      // AC-3: a second, independent guessing surface against the sharer's own credential (a
      // password/TOTP re-check on an already-authenticated session) — rate-limited separately
      // from AC-22's per-token reveal-attempt cap, which protects the recipient-facing endpoint.
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/external-shares',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialShareParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<CreateExternalCredentialShareBody>(
        CreateExternalCredentialShareBodySchema,
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

      // AC-2: identical eligibility gate as member-share creation and normal reveal — no looser
      // check for the external path.
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

      // AC-3: step-up re-authentication BEFORE any mutation. A missing/incorrect factor returns
      // 401 step_up_required with no share created and no partial side effects.
      const stepUp = await verifyStepUp(secureCtx.tx, {
        userId: secureCtx.auth.userId,
        password: parsed.data.password,
        totpCode: parsed.data.totpCode,
      })
      if (stepUp.status !== 'ok') {
        return reply.status(401).send({
          code: 'step_up_required',
          message:
            stepUp.status === 'missing_factor'
              ? 'A password or TOTP code is required to create an external share.'
              : 'The supplied password or TOTP code is incorrect.',
        })
      }

      const result = await createExternalCredentialShare(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        credentialId: params.credentialId,
        sharedByUserId: secureCtx.auth.userId,
        recipientEmail: parsed.data.recipientEmail,
        fieldKey: parsed.data.fieldKey,
        expiresAt: new Date(parsed.data.expiresAt),
      })
      if (result.status !== 'ok') return createExternalShareErrorResponse(reply, result)

      try {
        await writeShareAuditEntry(secureCtx.tx, secureCtx.auth, req, {
          eventType: AuditEvent.CREDENTIAL_SHARE_CREATED,
          resourceId: result.share.id,
          payload: {
            credentialId: params.credentialId,
            projectId: params.projectId,
            recipientType: 'external',
            recipientEmail: result.share.recipientEmail,
            fieldKey: result.share.fieldKey,
            singleUse: result.share.singleUse,
            expiresAt: result.share.expiresAt.toISOString(),
          },
        })
      } catch (error) {
        req.log.error(
          { eventType: AUDIT_FAILED_EVENT_TYPE, credentialId: params.credentialId },
          'External credential share audit write failed — transaction will roll back'
        )
        throw error
      }

      // AC-12/AC-18: admin notification on creation (external recipients have no in-app account
      // to notify) — best-effort, never blocks or rolls back share creation.
      let jobs: NotificationQueueJob[] = []
      try {
        jobs = await createOrgAdminNotificationEntries({
          orgId: secureCtx.auth.orgId,
          template: {
            templateId: 'credential.external_share_created',
            payload: {
              shareId: result.share.id,
              credentialId: params.credentialId,
              sharedByUserId: secureCtx.auth.userId,
              fieldKey: result.share.fieldKey,
              expiresAt: result.share.expiresAt.toISOString(),
            },
            severity: 'warning',
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
          'External credential share notification dispatch failed — share was still created'
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

      // AC-5: org admins/owners can revoke any share on the credential, so they can also list
      // every share on it (not just their own) — otherwise there is no way to discover a
      // shareId to exercise that right.
      const isAdmin = roleRank(secureCtx.auth.orgRole) >= roleRank('admin')
      const shares = await listSharesForCredential(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        sharedByUserId: isAdmin ? undefined : secureCtx.auth.userId,
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
      // admin-can-manage-project-scoped-resources convention). Authorization MUST be checked
      // before any mutation — the route runs inside a transaction that commits on any
      // non-throwing return, so a mutation followed by a 403 would still persist.
      const target = await findShareInScope(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        shareId: params.shareId,
      })
      if (!target) return reply.status(404).send(SHARE_NOT_FOUND)

      if (
        target.sharedBy !== secureCtx.auth.userId &&
        roleRank(secureCtx.auth.orgRole) < roleRank('admin')
      ) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Only the sharer or an org admin can revoke this share.',
        })
      }

      const existing = await revokeShare(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        shareId: params.shareId,
      })
      if (existing.status === 'not_found') return reply.status(404).send(SHARE_NOT_FOUND)

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
            { eventType: AUDIT_FAILED_EVENT_TYPE, shareId: params.shareId },
            'Credential share revoke audit write failed — transaction will roll back'
          )
          throw error
        }
      }

      return { data: serializeShare(existing.share) }
    },
  })
}
