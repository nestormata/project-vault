import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { validationError } from '../../lib/route-helpers.js'
import {
  SameTransactionAuditWriteError,
  secureRoute,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import {
  AddVersionBodySchema,
  AddVersionResponseSchema,
  CreateCredentialBodySchema,
  CredentialDetailResponseSchema,
  CredentialParamsSchema,
  CredentialValueResponseSchema,
  CredentialVersionListResponseSchema,
  ProjectScopeParamsSchema,
  type AddVersionBody,
  type CreateCredentialBody,
} from './schema.js'
import {
  VersionConflictError,
  addCredentialVersion,
  createCredentialWithFirstVersion,
  findProjectInOrg,
  listVersionHistory,
  revealCurrentValue,
} from './service.js'

type CredentialAuditInput = {
  orgId: string
  actorUserId: string
  eventType: 'credential.created' | 'credential.version_created' | 'credential.value_revealed'
  resourceId: string
  payload: Record<string, unknown>
  request: FastifyRequest
}

async function writeCredentialAudit(tx: Tx, input: CredentialAuditInput): Promise<void> {
  try {
    const actorTokenId = await firstActorTokenIdForUser(tx, input.actorUserId)
    await writeHumanAuditEntry(tx, {
      orgId: input.orgId,
      actorTokenId,
      eventType: input.eventType,
      resourceId: input.resourceId,
      resourceType: 'credential',
      payload: input.payload,
      meta: {
        ipAddress: input.request.ip,
        userAgent:
          typeof input.request.headers['user-agent'] === 'string'
            ? input.request.headers['user-agent']
            : null,
      },
    })
  } catch (error) {
    throw new SameTransactionAuditWriteError(error instanceof Error ? error.message : String(error))
  }
}

async function writeCredentialAuditOrFailClosed(
  req: FastifyRequest,
  tx: Tx,
  input: CredentialAuditInput
): Promise<void> {
  try {
    await writeCredentialAudit(tx, input)
  } catch (error) {
    req.log.error(
      {
        eventType: OperationalEvent.CREDENTIAL_AUDIT_WRITE_FAILED,
        orgId: input.orgId,
        auditEventType: input.eventType,
        resourceId: input.resourceId,
      },
      'Credential audit write failed — transaction will roll back'
    )
    throw error
  }
}

function parseBody<T>(
  schema: {
    safeParse: (
      body: unknown
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }
  },
  req: FastifyRequest,
  reply: FastifyReply
): { success: true; data: T } | { success: false } {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, 'body'))
    return { success: false }
  }
  return { success: true, data: parsed.data }
}

function parseProjectScopeParams(req: FastifyRequest, reply: FastifyReply) {
  const parsed = ProjectScopeParamsSchema.safeParse(req.params)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, 'params'))
    return null
  }
  return parsed.data
}

function parseCredentialParams(req: FastifyRequest, reply: FastifyReply) {
  const parsed = CredentialParamsSchema.safeParse(req.params)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, 'params'))
    return null
  }
  return parsed.data
}

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const

export async function credentialRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials',
    schema: {
      response: {
        201: CredentialDetailResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      requireMfa: false,
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseProjectScopeParams(req, reply)
      if (!params) return reply
      const parsed = parseBody<CreateCredentialBody>(CreateCredentialBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const projectExists = await findProjectInOrg(secureCtx.tx, params.projectId)
      if (!projectExists) return reply.status(404).send(PROJECT_NOT_FOUND)

      const { credential, detail } = await createCredentialWithFirstVersion(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        body: parsed.data,
      })

      await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.created',
        resourceId: credential.id,
        payload: { name: credential.name, projectId: params.projectId },
        request: req,
      })

      reply.status(201)
      return { data: detail }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/versions',
    schema: {
      response: {
        201: AddVersionResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/versions',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseCredentialParams(req, reply)
      if (!params) return reply
      const parsed = parseBody<AddVersionBody>(AddVersionBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      let version
      try {
        version = await addCredentialVersion(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          projectId: params.projectId,
          userId: secureCtx.auth.userId,
          body: parsed.data,
        })
      } catch (error) {
        if (error instanceof VersionConflictError) {
          return reply.status(409).send({ code: 'version_conflict', message: error.message })
        }
        throw error
      }
      if (!version) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.version_created',
        resourceId: params.credentialId,
        payload: { versionNumber: version.versionNumber },
        request: req,
      })

      reply.status(201)
      return {
        data: {
          credentialId: params.credentialId,
          versionNumber: version.versionNumber,
          createdAt: version.createdAt.toISOString(),
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/value',
    schema: {
      response: {
        200: CredentialValueResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        max: 120,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/projects/:projectId/credentials/:credentialId/value',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseCredentialParams(req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_REVEAL_ATTEMPT,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          actorTokenId: secureCtx.auth.userId,
        },
        'Credential value reveal attempted'
      )

      const revealed = await revealCurrentValue(secureCtx.tx, params)
      if (!revealed) {
        req.log.warn(
          {
            eventType: OperationalEvent.CREDENTIAL_REVEAL_FAILURE,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            reason: 'not_found',
          },
          'Credential value reveal failed'
        )
        return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      }

      try {
        await writeCredentialAudit(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: 'credential.value_revealed',
          resourceId: params.credentialId,
          payload: { versionNumber: revealed.versionNumber },
          request: req,
        })
      } catch (error) {
        req.log.error(
          {
            eventType: OperationalEvent.CREDENTIAL_AUDIT_WRITE_FAILED,
            orgId: secureCtx.auth.orgId,
            auditEventType: 'credential.value_revealed',
            resourceId: params.credentialId,
          },
          'Credential audit write failed — transaction will roll back'
        )
        req.log.warn(
          {
            eventType: OperationalEvent.CREDENTIAL_REVEAL_FAILURE,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            reason: 'audit_write_failed',
          },
          'Credential value reveal failed'
        )
        throw error
      }

      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_REVEAL_SUCCESS,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          versionNumber: revealed.versionNumber,
        },
        'Credential value revealed'
      )

      return {
        data: {
          value: revealed.value,
          versionNumber: revealed.versionNumber,
          retrievedAt: new Date().toISOString(),
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/versions',
    schema: {
      response: {
        200: CredentialVersionListResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseCredentialParams(req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const items = await listVersionHistory(secureCtx.tx, params)
      if (!items) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      return { data: { items } }
    },
  })
}
