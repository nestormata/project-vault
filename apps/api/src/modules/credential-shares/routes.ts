import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuditEvent, normalizeFieldKey } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import {
  enforceUserRateLimit,
  parseBody,
  parseParams,
  parseQuery,
} from '../../lib/route-helpers.js'
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
  dispatchDirectEmailNotification,
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
  DEFAULT_SHARE_LIST_LIMIT,
  DismissNudgeBodySchema,
  DismissNudgeResponseSchema,
  ListCredentialSharesQuerySchema,
  ListCredentialSharesResponseSchema,
  ListNudgeResponseSchema,
  MAX_ATTRIBUTE_KEYS,
  MAX_SHARE_LIST_LIMIT,
  RevokeCredentialShareResponseSchema,
  type CreateCredentialShareBody,
  type CreateExternalCredentialShareBody,
  type DismissNudgeBody,
} from './schema.js'
import {
  countSharesForCredential,
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
import { computeRotationRecommendedNudges, dismissRotationRecommendedNudge } from './nudge.js'
import { verifyStepUp } from './step-up.js'

const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const
const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const SHARE_NOT_FOUND = { code: 'share_not_found', message: 'Share not found' } as const
const AUDIT_FAILED_EVENT_TYPE = 'credential_share.audit_failed'
const SHARE_EMAIL_PAIR_RATE_LIMIT = {
  max: 5,
  timeWindowMs: 60_000,
  key: 'credential-share-email-recipient',
} as const

function enforceShareRecipientEmailRateLimit(
  userId: string,
  recipient: string,
  reply: FastifyReply
): boolean {
  return enforceUserRateLimit({
    // The primitive scopes its window by userId+key. Supplying the pair here prevents a sharer
    // from repeatedly sending mail to one target while leaving different recipients independent.
    userId: `${userId}:${recipient.trim().toLowerCase()}`,
    reply,
    ...SHARE_EMAIL_PAIR_RATE_LIMIT,
  })
}

async function rejectIfExternalShareStepUpFails(
  tx: SecureRouteContext['tx'],
  body: Pick<CreateExternalCredentialShareBody, 'password' | 'totpCode'>,
  userId: string,
  reply: FastifyReply
): Promise<boolean> {
  const stepUp = await verifyStepUp(tx, {
    userId,
    password: body.password,
    totpCode: body.totpCode,
  })
  if (stepUp.status === 'ok') return false
  reply.status(401).send({
    code: 'step_up_required',
    message:
      stepUp.status === 'missing_factor'
        ? 'A password or TOTP code is required to create an external share.'
        : 'The supplied password or TOTP code is incorrect.',
  })
  return true
}

function rejectInvalidExternalShareRequest(
  userId: string,
  body: CreateExternalCredentialShareBody,
  reply: FastifyReply
): boolean {
  if (body.singleUse === false) {
    reply.status(400).send({
      code: 'external_share_must_be_single_use',
      message: 'External shares must be single-use; singleUse: false is not supported.',
    })
    return true
  }
  return !enforceShareRecipientEmailRateLimit(userId, body.recipientEmail, reply)
}

export function serializeShare(share: CredentialShareRow) {
  return {
    id: share.id,
    credentialId: share.credentialId,
    fieldKey: share.fieldKey,
    // Story 20.5 AC-1: the persisted `BoundedShareScope` fields.
    attributeKeys: share.attributeKeys,
    action: share.action,
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

// Story 20.5 (review patch): factored out of both `createShareErrorResponse` and
// `createExternalShareErrorResponse` below — they handled `unknown_field_key`/
// `ambiguous_share_scope` identically, and the duplication tripped jscpd once the second status
// was added.
function shareScopeErrorResponse(
  reply: FastifyReply,
  result:
    | { status: 'unknown_field_key'; field: string }
    | { status: 'ambiguous_share_scope' }
    | { status: 'too_many_attribute_keys' }
): unknown {
  if (result.status === 'unknown_field_key') {
    return reply.status(400).send({
      code: 'unknown_field_key',
      message: `Unknown field key: '${result.field}'`,
      field: result.field,
    })
  }
  if (result.status === 'too_many_attribute_keys') {
    return reply.status(400).send({
      code: 'too_many_attribute_keys',
      message: `attributeKeys must name at most ${MAX_ATTRIBUTE_KEYS} distinct fields.`,
    })
  }
  return reply.status(400).send({
    code: 'ambiguous_share_scope',
    message: 'Specify at most one of fieldKey or attributeKeys.',
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
  if (
    result.status === 'unknown_field_key' ||
    result.status === 'ambiguous_share_scope' ||
    result.status === 'too_many_attribute_keys'
  ) {
    return shareScopeErrorResponse(reply, result)
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
  if (
    result.status === 'unknown_field_key' ||
    result.status === 'ambiguous_share_scope' ||
    result.status === 'too_many_attribute_keys'
  ) {
    return shareScopeErrorResponse(reply, result)
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

/** Shared by both share-creation routes (member and external): resolves project visibility, then
 *  AC-1/AC-2's identical eligibility gate ("share-creation reuses reveal's exact permission check
 *  — never a second, parallel check that could drift out of sync with reveal's rules"). Returns
 *  `true` (having already sent the reply) when the caller must stop. */
async function rejectIfShareCreationUnauthorized(
  secureCtx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  credentialId: string
): Promise<boolean> {
  if (await rejectIfProjectNotVisible(secureCtx, req, reply, projectId, PROJECT_NOT_FOUND)) {
    return true
  }
  return rejectIfInsufficientProjectRoleForReveal(
    secureCtx,
    req,
    reply,
    projectId,
    credentialId,
    'reveal'
  )
}

/** Shared by both share-creation routes: logs an audit-write failure with a route-specific label
 *  and rethrows, so the enclosing transaction rolls back the same way in both places. */
function logShareAuditFailureAndRethrow(
  req: FastifyRequest,
  credentialId: string,
  contextLabel: string,
  error: unknown
): never {
  req.log.error(
    { eventType: AUDIT_FAILED_EVENT_TYPE, credentialId },
    `${contextLabel} audit write failed — transaction will roll back`
  )
  throw error
}

/** Shared by both share-creation routes: shapes the CREDENTIAL_SHARE_CREATED audit payload
 *  (common fields plus a route-specific `extraPayload`). Deliberately does NOT itself call
 *  `writeShareAuditEntry` — `route-audit.test.ts`'s `assertAuditedActionOptOutsAreJustified` scans
 *  each route's own registration source for a literal `writeShareAuditEntry(secureCtx.tx, ...)`
 *  call to confirm the audit write is threaded through the request's own transaction, so that call
 *  must stay inline in each route handler rather than moving behind a shared wrapper. */
function buildShareCreationAuditPayload(
  params: { credentialId: string; projectId: string },
  share: CredentialShareRow,
  extraPayload: Record<string, unknown>
): { eventType: string; resourceId: string; payload: Record<string, unknown> } {
  return {
    eventType: AuditEvent.CREDENTIAL_SHARE_CREATED,
    resourceId: share.id,
    payload: {
      credentialId: params.credentialId,
      projectId: params.projectId,
      ...extraPayload,
      fieldKey: share.fieldKey,
      singleUse: share.singleUse,
      expiresAt: share.expiresAt.toISOString(),
    },
  }
}

/** Shared by both share-creation routes: a best-effort notification dispatch failure never blocks
 *  or rolls back the share that was already created. */
function warnShareNotificationDispatchFailed(
  req: { log: { warn: (payload: unknown, msg: string) => void } },
  shareId: string,
  contextLabel: string,
  error: unknown
): void {
  req.log.warn(
    { eventType: 'credential_share.notification_failed', shareId, err: error },
    `${contextLabel} notification dispatch failed — share was still created`
  )
}

/** Shared by the list/nudge/dismiss routes below (none of which mutate a share the way create/
 *  revoke do): resolves project visibility, then confirms the credential itself exists in that
 *  project. Returns `true` (having already sent the reply) when the caller must stop. */
async function rejectIfCredentialNotVisible(
  secureCtx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  params: { projectId: string; credentialId: string }
): Promise<boolean> {
  if (await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId, PROJECT_NOT_FOUND)) {
    return true
  }
  const exists = await credentialExistsInProject(secureCtx.tx, params)
  if (!exists) {
    reply.status(404).send(CREDENTIAL_NOT_FOUND)
    return true
  }
  return false
}

type VisibleCredentialLoad = {
  params: { projectId: string; credentialId: string }
  secureCtx: SecureRouteContext
}

/** Shared by the GET .../shares, GET .../nudge, and POST .../nudge/dismiss handlers: the common
 *  params-parse + visibility-check prologue every one of them starts with. Returns `null` (having
 *  already sent the reply) when the caller must stop. */
async function loadVisibleCredentialParams(
  ctx: unknown,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<VisibleCredentialLoad | null> {
  const params = parseParams(CredentialShareParamsSchema, req, reply)
  if (!params) return null
  const secureCtx = ctx as SecureRouteContext
  if (await rejectIfCredentialNotVisible(secureCtx, req, reply, params)) return null
  return { params, secureCtx }
}

/** Wraps a route handler so `loadVisibleCredentialParams`'s own "parse, check, bail" prologue is
 *  written exactly once instead of being repeated verbatim at every one of this module's 3
 *  visibility-gated GET/POST handlers (jscpd's 0%-duplication gate treats that repeated prologue
 *  as a clone once factored only as far as a shared function still called inline 3 times). */
function withVisibleCredential(
  fn: (req: FastifyRequest, reply: FastifyReply, loaded: VisibleCredentialLoad) => Promise<unknown>
) {
  return async (ctx: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const loaded = await loadVisibleCredentialParams(ctx, req, reply)
    if (!loaded) return reply
    return fn(req, reply, loaded)
  }
}

/** Shared by both share-creation routes: the 201 response finalization — serialize the share plus
 *  its one-time token, then flush any best-effort notification jobs. */
async function finalizeShareCreationResponse(
  fastify: FastifyApp,
  req: { log: { warn: (payload: unknown, msg: string) => void } },
  reply: FastifyReply,
  share: CredentialShareRow,
  token: string,
  jobs: NotificationQueueJob[]
) {
  reply.status(201)
  const response = { data: { ...serializeShare(share), token } }
  await sendPendingShareNotifications(fastify, req, jobs)
  return response
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
        !enforceShareRecipientEmailRateLimit(
          secureCtx.auth.userId,
          parsed.data.recipientUserId,
          reply
        )
      ) {
        return reply
      }

      // AC-1: share-creation eligibility reuses reveal's exact permission gate — never a second,
      // parallel check that could drift out of sync with reveal's rules.
      if (
        await rejectIfShareCreationUnauthorized(
          secureCtx,
          req,
          reply,
          params.projectId,
          params.credentialId
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
        attributeKeys: parsed.data.attributeKeys,
        expiresAt: new Date(parsed.data.expiresAt),
        singleUse: parsed.data.singleUse,
      })
      if (result.status !== 'ok') return createShareErrorResponse(reply, result)

      try {
        await writeShareAuditEntry(
          secureCtx.tx,
          secureCtx.auth,
          req,
          buildShareCreationAuditPayload(params, result.share, {
            recipientUserId: parsed.data.recipientUserId,
            attributeKeys: result.share.attributeKeys,
            action: result.share.action,
          })
        )
      } catch (error) {
        logShareAuditFailureAndRethrow(req, params.credentialId, 'Credential share', error)
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
        warnShareNotificationDispatchFailed(req, result.share.id, 'Credential share', error)
      }

      return finalizeShareCreationResponse(fastify, req, reply, result.share, result.token, jobs)
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

      // AC-5: external shares are always single-use — the body may omit `singleUse` or pass
      // `true`, but an explicit `false` is a distinct, documented 400. The same helper applies
      // Story 18.6's per-sharer/recipient email limit.
      if (rejectInvalidExternalShareRequest(secureCtx.auth.userId, parsed.data, reply)) {
        return reply
      }

      // AC-2: identical eligibility gate as member-share creation and normal reveal — no looser
      // check for the external path.
      if (
        await rejectIfShareCreationUnauthorized(
          secureCtx,
          req,
          reply,
          params.projectId,
          params.credentialId
        )
      ) {
        return reply
      }

      // AC-3: step-up re-authentication BEFORE any mutation. A missing/incorrect factor returns
      // 401 step_up_required with no share created and no partial side effects.
      if (
        await rejectIfExternalShareStepUpFails(
          secureCtx.tx,
          parsed.data,
          secureCtx.auth.userId,
          reply
        )
      )
        return reply

      const result = await createExternalCredentialShare(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        credentialId: params.credentialId,
        sharedByUserId: secureCtx.auth.userId,
        recipientEmail: parsed.data.recipientEmail,
        fieldKey: parsed.data.fieldKey,
        attributeKeys: parsed.data.attributeKeys,
        expiresAt: new Date(parsed.data.expiresAt),
      })
      if (result.status !== 'ok') return createExternalShareErrorResponse(reply, result)

      try {
        await writeShareAuditEntry(
          secureCtx.tx,
          secureCtx.auth,
          req,
          buildShareCreationAuditPayload(params, result.share, {
            recipientType: 'external',
            recipientEmail: result.share.recipientEmail,
            attributeKeys: result.share.attributeKeys,
            action: result.share.action,
          })
        )
      } catch (error) {
        logShareAuditFailureAndRethrow(req, params.credentialId, 'External credential share', error)
      }

      // Story 18.6: external recipients have no account/preferences, so queue the existing
      // no-token share notice directly to their captured address. Preserve Story 17.2's
      // independent org-admin alert too. Both are best-effort and never block creation.
      let jobs: NotificationQueueJob[] = []
      try {
        const [recipientJobs, adminJobs] = await Promise.all([
          dispatchDirectEmailNotification({
            orgId: secureCtx.auth.orgId,
            recipientEmail: result.share.recipientEmail ?? parsed.data.recipientEmail,
            template: {
              templateId: 'credential.share_created',
              payload: {
                shareId: result.share.id,
                credentialId: params.credentialId,
                sharedByUserId: secureCtx.auth.userId,
                fieldKey: result.share.fieldKey,
                recipientType: 'external',
              },
            },
            tx: secureCtx.tx,
          }),
          createOrgAdminNotificationEntries({
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
          }),
        ])
        jobs = [...recipientJobs, ...adminJobs]
      } catch (error) {
        warnShareNotificationDispatchFailed(
          req,
          result.share.id,
          'External credential share',
          error
        )
      }

      return finalizeShareCreationResponse(fastify, req, reply, result.share, result.token, jobs)
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
        422: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'member', writeAuditEvent: false },
    handler: withVisibleCredential(async (req, reply, { params, secureCtx }) => {
      // AC-1: an invalid `status` value is a 422, not a silent empty result or a 500 from an
      // unconstrained SQL IN — zod's own enum validation rejects it before this handler ever
      // touches the DB.
      const query = parseQuery(ListCredentialSharesQuerySchema, req, reply)
      if (!query) return reply

      // AC-5: org admins/owners can revoke any share on the credential, so they can also list
      // every share on it (not just their own) — otherwise there is no way to discover a
      // shareId to exercise that right. AC-1/AC-2: status filter + pagination are additive on
      // top of this existing member-vs-admin scoping.
      const isAdmin = roleRank(secureCtx.auth.orgRole) >= roleRank('admin')
      // AC-2 edge case: an over-large `limit` is clamped to MAX_SHARE_LIST_LIMIT server-side,
      // never rejected — same convention as `parsePagination`'s own Math.min clamp.
      const limit = Math.min(query.limit ?? DEFAULT_SHARE_LIST_LIMIT, MAX_SHARE_LIST_LIMIT)
      const offset = query.offset ?? 0
      const listParams = {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        sharedByUserId: isAdmin ? undefined : secureCtx.auth.userId,
        status: query.status,
        limit,
        offset,
      }
      const [shares, total] = await Promise.all([
        listSharesForCredential(secureCtx.tx, listParams),
        countSharesForCredential(secureCtx.tx, listParams),
      ])
      return { data: { items: shares.map(serializeShare), total } }
    }),
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
              attributeKeys: existing.share.attributeKeys,
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

  // Story 17.3 AC-11: a small, dedicated GET route (documented Task 5.1 choice — see Dev Agent
  // Record) rather than folding into the existing credential-detail response.
  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/nudge',
    schema: {
      response: {
        200: ListNudgeResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'member', writeAuditEvent: false },
    handler: withVisibleCredential(async (_req, _reply, { params, secureCtx }) => {
      const items = await computeRotationRecommendedNudges(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        viewerUserId: secureCtx.auth.userId,
        viewerIsAdmin: roleRank(secureCtx.auth.orgRole) >= roleRank('admin'),
      })
      return { data: { items } }
    }),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/nudge/dismiss',
    schema: {
      response: {
        200: DismissNudgeResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/nudge/dismiss',
      },
    },
    handler: withVisibleCredential(async (req, reply, { params, secureCtx }) => {
      const parsed = parseBody<DismissNudgeBody>(DismissNudgeBodySchema, req, reply)
      if (!parsed.success) return reply

      // Bugfix (post-implementation review): `credential_shares.fieldKey` is always stored via
      // `normalizeFieldKey` (trim + NFC + lowercase, see `validateFieldKey`). A dismissal must be
      // normalized identically, or a differently-cased/whitespaced `fieldKey` silently lands in a
      // bucket with zero matching shares and the dismissal appears to succeed (200) while never
      // actually clearing the intended nudge (AC-11/AC-15's bucket keys must match exactly).
      const fieldKey = parsed.data.fieldKey ? normalizeFieldKey(parsed.data.fieldKey) : null
      const result = await dismissRotationRecommendedNudge(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        credentialId: params.credentialId,
        fieldKey,
        dismissedBy: secureCtx.auth.userId,
        reason: parsed.data.reason,
      })
      // AC-15: an empty/whitespace-only reason is a 422 — the zod schema above already trims and
      // requires min-length-1, so this branch is unreachable via this route today, but the
      // service-layer guard is kept authoritative rather than trusted-by-construction, matching
      // this module's other double-checked invariants (e.g. `validateShareFieldAndExpiry`).
      if (result.status === 'empty_reason') {
        return reply.status(422).send({
          code: 'empty_reason',
          message: 'reason must not be empty.',
        })
      }

      try {
        await writeShareAuditEntry(secureCtx.tx, secureCtx.auth, req, {
          eventType: AuditEvent.CREDENTIAL_SHARE_NUDGE_DISMISSED,
          resourceId: params.credentialId,
          payload: {
            credentialId: params.credentialId,
            projectId: params.projectId,
            fieldKey,
            reason: parsed.data.reason.trim(),
          },
        })
      } catch (error) {
        req.log.error(
          { eventType: AUDIT_FAILED_EVENT_TYPE, credentialId: params.credentialId },
          'Credential share nudge dismissal audit write failed — transaction will roll back'
        )
        throw error
      }

      return { data: { fieldKey, dismissedAt: result.dismissedAt.toISOString() } }
    }),
  })
}
