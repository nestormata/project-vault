import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import {
  buildPaginationMeta,
  PAGE_OUT_OF_RANGE_ERROR,
  resolvePaginationOffset,
} from '../../lib/pagination.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { findProjectInOrg } from '../credentials/service.js'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import type { Tx } from '@project-vault/db'
import { generateApiKey, hashApiKey } from './tokens.js'
import {
  ApiKeyParamsSchema,
  CreateMachineUserBodySchema,
  IssueApiKeyBodySchema,
  IssueApiKeyResponseSchema,
  ListApiKeysResponseSchema,
  MachineUserListResponseSchema,
  MachineUserParamsSchema,
  MachineUserResponseSchema,
  MAX_MACHINE_USER_LIST_OFFSET,
  PaginationQuerySchema,
  ProjectScopeParamsSchema,
  RevokeApiKeyResponseSchema,
  type ApiKeyIssued,
  type ApiKeyMetadata,
  type MachineUserDetail,
  type MachineUserSummary,
} from './schema.js'

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const MACHINE_USER_NOT_FOUND = {
  code: 'machine_user_not_found',
  message: 'Machine user not found',
} as const
const API_KEY_NOT_FOUND = { code: 'api_key_not_found', message: 'API key not found' } as const
const MACHINE_USER_DEACTIVATED = {
  code: 'machine_user_deactivated',
  message: 'Machine user is deactivated',
} as const

type MachineUserRow = typeof machineUsers.$inferSelect
type ApiKeyRow = typeof apiKeys.$inferSelect

// UX-DR11: the scope-boundary block shown on creation (before any key exists) and detail views.
function scopeBoundaryFor(row: Pick<MachineUserRow, 'projectId' | 'name'>) {
  return {
    canAccess: [`credentials in project ${row.projectId} (${row.name}'s assigned project)`],
    cannotAccess: ['other projects', 'org settings', 'audit logs'],
  }
}

function machineUserSummaryFields(row: MachineUserRow): MachineUserSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    role: row.role as 'member' | 'viewer',
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
  }
}

function toMachineUserDetail(row: MachineUserRow): MachineUserDetail {
  return { ...machineUserSummaryFields(row), scopeBoundary: scopeBoundaryFor(row) }
}

function toMachineUserSummary(row: MachineUserRow): MachineUserSummary {
  return machineUserSummaryFields(row)
}

function toApiKeyIssued(row: ApiKeyRow, plaintext: string): ApiKeyIssued {
  return {
    id: row.id,
    machineUserId: row.machineUserId,
    name: row.name,
    key: plaintext,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toApiKeyMetadata(row: ApiKeyRow): ApiKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    isRevoked: row.revokedAt !== null,
  }
}

async function findMachineUserById(
  tx: Tx,
  machineUserId: string
): Promise<MachineUserRow | undefined> {
  const rows = await tx
    .select()
    .from(machineUsers)
    .where(eq(machineUsers.id, machineUserId))
    .limit(1)
  return rows[0]
}

/** Parses page/limit query params and resolves a bounded offset, replying with 422 on either
 * validation or an out-of-range page. Shared by both list endpoints in this module. */
function parseListQuery(
  req: FastifyRequest,
  reply: FastifyReply
): { pagination: { page: number; limit: number }; offset: number } | null {
  const parsedQuery = PaginationQuerySchema.safeParse(req.query)
  if (!parsedQuery.success) {
    reply.status(422).send(validationError(parsedQuery.error, 'query'))
    return null
  }
  const resolved = resolvePaginationOffset(
    parsedQuery.data.page,
    parsedQuery.data.limit,
    MAX_MACHINE_USER_LIST_OFFSET
  )
  if (!resolved) {
    reply.status(422).send(PAGE_OUT_OF_RANGE_ERROR)
    return null
  }
  return resolved
}

const MACHINE_USERS_RATE_LIMIT_WINDOW_MS = 60_000
const MACHINE_USER_MUTATION_RATE_LIMIT = 10

// Shared by every read-only route in this module (detail + both list endpoints): identical
// error-response tail and security config, so call sites spread these instead of repeating the
// same object literal (avoids a near-duplicate handler-preamble clone between the two flat
// /machine-users/:machineUserId... routes, which otherwise share an identical params schema).
const READ_ERROR_RESPONSES = { 401: ApiErrorSchema, 404: ApiErrorSchema, 422: ApiErrorSchema }
const READ_SECURITY = { minimumRole: 'viewer', writeAuditEvent: false } as const

export async function machineUserRoutes(fastify: FastifyApp): Promise<void> {
  // AC-3/AC-4/AC-5/AC-6: create a machine user, project-nested.
  secureRoute(fastify, {
    method: 'POST',
    url: '/projects/:projectId/machine-users',
    schema: {
      response: {
        201: MachineUserResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: MACHINE_USER_MUTATION_RATE_LIMIT,
        timeWindowMs: MACHINE_USERS_RATE_LIMIT_WINDOW_MS,
        key: 'POST /api/v1/projects/:projectId/machine-users',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(CreateMachineUserBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const projectExists = await findProjectInOrg(secureCtx.tx, params.projectId)
      if (!projectExists) return reply.status(404).send(PROJECT_NOT_FOUND)

      const [inserted] = await secureCtx.tx
        .insert(machineUsers)
        .values({
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          role: parsed.data.role,
          createdBy: secureCtx.auth.userId,
        })
        .returning()
      const newMachineUser = inserted as MachineUserRow

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'machine_user',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.MACHINE_USER_CREATED,
        resourceId: newMachineUser.id,
        payload: {
          name: parsed.data.name,
          role: parsed.data.role,
          description: parsed.data.description ?? null,
        },
        request: req,
      })

      reply.status(201)
      return { data: toMachineUserDetail(newMachineUser) }
    },
  })

  // AC-7: list machine users in a project.
  secureRoute(fastify, {
    method: 'GET',
    url: '/projects/:projectId/machine-users',
    schema: { response: { 200: MachineUserListResponseSchema, ...READ_ERROR_RESPONSES } },
    security: READ_SECURITY,
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const resolvedQuery = parseListQuery(req, reply)
      if (!resolvedQuery) return reply
      const { pagination, offset } = resolvedQuery
      const secureCtx = ctx as SecureRouteContext

      const projectExists = await findProjectInOrg(secureCtx.tx, params.projectId)
      if (!projectExists) return reply.status(404).send(PROJECT_NOT_FOUND)

      const [{ total } = { total: 0 }] = await secureCtx.tx
        .select({ total: sql<number>`count(*)` })
        .from(machineUsers)
        .where(eq(machineUsers.projectId, params.projectId))
      const rows = await secureCtx.tx
        .select()
        .from(machineUsers)
        .where(eq(machineUsers.projectId, params.projectId))
        .orderBy(machineUsers.createdAt)
        .limit(pagination.limit)
        .offset(offset)

      return {
        data: {
          items: rows.map(toMachineUserSummary),
          ...buildPaginationMeta(pagination, Number(total)),
        },
      }
    },
  })

  // AC-8: single machine-user detail (flat route, org-scoped).
  secureRoute(fastify, {
    method: 'GET',
    url: '/machine-users/:machineUserId',
    schema: { response: { 200: MachineUserResponseSchema, ...READ_ERROR_RESPONSES } },
    security: READ_SECURITY,
    handler: async (ctx, req, reply) => {
      const params = parseParams(MachineUserParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const row = await findMachineUserById(secureCtx.tx, params.machineUserId)
      if (!row) return reply.status(404).send(MACHINE_USER_NOT_FOUND)

      return { data: toMachineUserDetail(row) }
    },
  })

  // AC-9/AC-10/AC-11: issue a new API key for a machine user.
  secureRoute(fastify, {
    method: 'POST',
    url: '/machine-users/:machineUserId/api-keys',
    schema: {
      response: {
        201: IssueApiKeyResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: MACHINE_USER_MUTATION_RATE_LIMIT,
        timeWindowMs: MACHINE_USERS_RATE_LIMIT_WINDOW_MS,
        key: 'POST /api/v1/machine-users/:machineUserId/api-keys',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(MachineUserParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(IssueApiKeyBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const machineUser = await findMachineUserById(secureCtx.tx, params.machineUserId)
      if (!machineUser) return reply.status(404).send(MACHINE_USER_NOT_FOUND)
      if (machineUser.deactivatedAt !== null) {
        return reply.status(409).send(MACHINE_USER_DEACTIVATED)
      }

      // AC-9/Dev Notes: the plaintext key must never reach a log or the audit payload — it is
      // only ever placed into this single 201 response body below.
      const plaintextKey = generateApiKey()
      const keyHash = hashApiKey(plaintextKey)

      const [inserted] = await secureCtx.tx
        .insert(apiKeys)
        .values({
          orgId: secureCtx.auth.orgId,
          machineUserId: params.machineUserId,
          name: parsed.data.name,
          keyHash,
          hmacKeyVersion: 1,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        })
        .returning()
      const newKey = inserted as ApiKeyRow

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'api_key',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.MACHINE_USER_API_KEY_ISSUED,
        resourceId: newKey.id,
        payload: { name: parsed.data.name, expiresAt: parsed.data.expiresAt ?? null },
        request: req,
      })

      reply.status(201)
      return { data: toApiKeyIssued(newKey, plaintextKey) }
    },
  })

  // AC-12: list a machine user's API keys — metadata only, never keyHash/plaintext.
  secureRoute(fastify, {
    method: 'GET',
    url: '/machine-users/:machineUserId/api-keys',
    schema: { response: { 200: ListApiKeysResponseSchema, ...READ_ERROR_RESPONSES } },
    security: READ_SECURITY,
    handler: async (ctx, req, reply) => {
      const params = parseParams(MachineUserParamsSchema, req, reply)
      if (!params) return reply
      const resolvedQuery = parseListQuery(req, reply)
      if (!resolvedQuery) return reply
      const { pagination, offset } = resolvedQuery
      const secureCtx = ctx as SecureRouteContext

      const machineUser = await findMachineUserById(secureCtx.tx, params.machineUserId)
      if (!machineUser) return reply.status(404).send(MACHINE_USER_NOT_FOUND)

      const [{ total } = { total: 0 }] = await secureCtx.tx
        .select({ total: sql<number>`count(*)` })
        .from(apiKeys)
        .where(eq(apiKeys.machineUserId, params.machineUserId))
      const rows = await secureCtx.tx
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.machineUserId, params.machineUserId))
        .orderBy(apiKeys.createdAt)
        .limit(pagination.limit)
        .offset(offset)

      return {
        data: {
          items: rows.map(toApiKeyMetadata),
          ...buildPaginationMeta(pagination, Number(total)),
        },
      }
    },
  })

  // AC-13/AC-17: revoke an API key — idempotent, app-captured timestamp, audit only on the
  // transaction that actually performs the state transition.
  secureRoute(fastify, {
    method: 'DELETE',
    url: '/machine-users/:machineUserId/api-keys/:keyId',
    schema: {
      response: {
        200: RevokeApiKeyResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: MACHINE_USER_MUTATION_RATE_LIMIT,
        timeWindowMs: MACHINE_USERS_RATE_LIMIT_WINDOW_MS,
        key: 'DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ApiKeyParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      // AC-17: capture the timestamp application-side. The UPDATE is gated on `revokedAt IS
      // NULL` so at most one of two concurrent callers can ever claim the row — Postgres blocks
      // the second UPDATE behind the first's row lock, then re-evaluates the WHERE clause
      // against the just-committed row, so the loser's WHERE simply matches 0 rows. This avoids
      // any timestamp-equality tie-break ambiguity (two concurrent calls can legitimately
      // capture the same millisecond).
      const revokedAt = new Date()
      const [claimed] = await secureCtx.tx
        .update(apiKeys)
        .set({ revokedAt })
        .where(
          and(
            eq(apiKeys.id, params.keyId),
            eq(apiKeys.machineUserId, params.machineUserId),
            isNull(apiKeys.revokedAt)
          )
        )
        .returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })

      let result: { id: string; revokedAt: Date | null }
      if (claimed) {
        result = claimed
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          resourceType: 'api_key',
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.MACHINE_USER_API_KEY_REVOKED,
          resourceId: claimed.id,
          payload: {},
          request: req,
        })
      } else {
        // Either the key doesn't exist/isn't in this org, or it was already revoked (by this
        // request retried, or a concurrent caller that won the race) — in both cases no audit
        // write happens here; re-read to distinguish "not found" from "already revoked".
        const [existing] = await secureCtx.tx
          .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.machineUserId, params.machineUserId)))
          .limit(1)
        if (!existing) return reply.status(404).send(API_KEY_NOT_FOUND)
        result = existing
      }

      return { data: { id: result.id, revokedAt: (result.revokedAt ?? revokedAt).toISOString() } }
    },
  })
}
