import type { FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import { buildPaginationMeta, paginationOffset, parsePagination } from '../../lib/pagination.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import {
  writeHumanAuditEntryOrFailClosed,
  type SameTransactionAuditInput,
} from '../../lib/audit-or-fail-closed.js'
import {
  AddVersionBodySchema,
  AddVersionResponseSchema,
  CreateCredentialBodySchema,
  CredentialDetailResponseSchema,
  CredentialParamsSchema,
  CredentialValueResponseSchema,
  CredentialVersionListResponseSchema,
  ListCredentialsQuerySchema,
  ListCredentialsResponseSchema,
  MAX_CREDENTIAL_LIST_OFFSET,
  ProjectScopeParamsSchema,
  TagArrayBodySchema,
  TagUpdateResponseSchema,
  type AddVersionBody,
  type CreateCredentialBody,
  type TagArrayBody,
} from './schema.js'
import {
  VersionConflictError,
  addCredentialVersion,
  createCredentialWithFirstVersion,
  findProjectInOrg,
  listCredentials,
  listVersionHistory,
  revealCurrentValue,
  updateCredentialTags,
} from './service.js'

type CredentialAuditInput = Omit<SameTransactionAuditInput, 'resourceType'> & {
  eventType:
    | 'credential.created'
    | 'credential.version_created'
    | 'credential.value_revealed'
    | 'credential.tags_updated'
}

async function writeCredentialAuditOrFailClosed(
  req: FastifyRequest,
  tx: Tx,
  input: CredentialAuditInput
): Promise<void> {
  try {
    await writeHumanAuditEntryOrFailClosed(tx, { ...input, resourceType: 'credential' })
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

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const
const CREDENTIAL_REVEAL_FAILED_MESSAGE = 'Credential value reveal failed'

export async function credentialRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials',
    schema: {
      response: {
        200: ListCredentialsResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: {
        max: 120,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/projects/:projectId/credentials',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const parsedQuery = ListCredentialsQuerySchema.safeParse(req.query)
      if (!parsedQuery.success) {
        return reply.status(422).send(validationError(parsedQuery.error, 'query'))
      }
      const secureCtx = ctx as SecureRouteContext
      const projectExists = await findProjectInOrg(secureCtx.tx, params.projectId)
      if (!projectExists) return reply.status(404).send(PROJECT_NOT_FOUND)

      const pagination = parsePagination(parsedQuery.data.page, parsedQuery.data.limit)
      const offset = paginationOffset(pagination)
      if (offset > MAX_CREDENTIAL_LIST_OFFSET) {
        return reply.status(422).send({
          code: 'page_out_of_range',
          message: 'Page is too deep; narrow your filters',
        })
      }

      const { items, total } = await listCredentials(secureCtx.tx, {
        projectId: params.projectId,
        query: parsedQuery.data,
        limit: pagination.limit,
        offset,
      })
      return { data: { items, ...buildPaginationMeta(pagination, total) } }
    },
  })

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
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
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
    method: 'PUT',
    url: '/:projectId/credentials/:credentialId/tags',
    schema: {
      response: {
        200: TagUpdateResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'PUT /api/v1/projects/:projectId/credentials/:credentialId/tags',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<TagArrayBody>(TagArrayBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await updateCredentialTags(secureCtx.tx, {
        ...params,
        body: parsed.data,
        mode: 'replace',
      })
      if (result.status === 'not_found') return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      if (result.status === 'too_many_tags') {
        return reply.status(422).send({
          code: 'too_many_tags',
          message: 'A credential may have at most 20 tags',
        })
      }

      await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.tags_updated',
        resourceId: params.credentialId,
        payload: result.auditPayload,
        request: req,
      })

      return { data: result.data }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId/credentials/:credentialId/tags',
    schema: {
      response: {
        200: TagUpdateResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'PATCH /api/v1/projects/:projectId/credentials/:credentialId/tags',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<TagArrayBody>(TagArrayBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await updateCredentialTags(secureCtx.tx, {
        ...params,
        body: parsed.data,
        mode: 'append',
      })
      if (result.status === 'not_found') return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      if (result.status === 'too_many_tags') {
        return reply.status(422).send({
          code: 'too_many_tags',
          message: 'A credential may have at most 20 tags',
        })
      }

      await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.tags_updated',
        resourceId: params.credentialId,
        payload: result.auditPayload,
        request: req,
      })

      return { data: result.data }
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
      const params = parseParams(CredentialParamsSchema, req, reply)
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
      const params = parseParams(CredentialParamsSchema, req, reply)
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

      let revealed: Awaited<ReturnType<typeof revealCurrentValue>>
      try {
        revealed = await revealCurrentValue(secureCtx.tx, params)
      } catch (error) {
        req.log.warn(
          {
            eventType: OperationalEvent.CREDENTIAL_REVEAL_FAILURE,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            reason: 'decrypt_error',
          },
          CREDENTIAL_REVEAL_FAILED_MESSAGE
        )
        throw error
      }

      if (revealed.status === 'not_found') {
        req.log.warn(
          {
            eventType: OperationalEvent.CREDENTIAL_REVEAL_FAILURE,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            reason: revealed.reason,
          },
          CREDENTIAL_REVEAL_FAILED_MESSAGE
        )
        return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      }

      try {
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          resourceType: 'credential',
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
          CREDENTIAL_REVEAL_FAILED_MESSAGE
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
      const params = parseParams(CredentialParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const items = await listVersionHistory(secureCtx.tx, params)
      if (!items) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      return { data: { items } }
    },
  })
}
