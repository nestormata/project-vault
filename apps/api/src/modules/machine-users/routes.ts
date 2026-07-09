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
import { activeMachineUserKeysQuery } from './archival-check.js'
import { emergencyRevokeApiKey, lockApiKeyForUpdate, rotateApiKey } from './rotation.js'
import {
  ActiveMachineUserKeysResponseSchema,
  ApiKeyParamsSchema,
  CreateMachineUserBodySchema,
  DeactivateMachineUserResponseSchema,
  EmergencyRevokeResponseSchema,
  ExtendDormancyBodySchema,
  ExtendDormancyResponseSchema,
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
  RotateApiKeyBodySchema,
  RotateApiKeyResponseSchema,
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
// Shared by rotate (AC-17) and emergency-revoke (AC-20) — both reject an already-revoked key.
const API_KEY_ALREADY_REVOKED = {
  code: 'api_key_already_revoked',
  message: 'This key has already been revoked',
} as const
const API_KEY_ALREADY_ROTATED = {
  code: 'api_key_already_rotated',
  message: 'This key has already been rotated',
} as const
const MACHINE_USER_DEACTIVATED = {
  code: 'machine_user_deactivated',
  message: 'Machine user is deactivated',
} as const

type MachineUserRow = typeof machineUsers.$inferSelect
type ApiKeyRow = typeof apiKeys.$inferSelect

/**
 * Shared by rotate/emergency-revoke (AC-17/AC-20/AC-26): row-locks the key and rejects a
 * not-found or already-revoked key with the response the caller already sent. Returns the row
 * on success, or null after the reply has been sent.
 */
async function lockAndRejectIfRevoked(
  secureCtx: SecureRouteContext,
  params: { machineUserId: string; keyId: string },
  reply: FastifyReply
): Promise<ApiKeyRow | null> {
  const oldKey = await lockApiKeyForUpdate(secureCtx.tx, params)
  if (!oldKey) {
    reply.status(404).send(API_KEY_NOT_FOUND)
    return null
  }
  if (oldKey.revokedAt !== null) {
    reply.status(409).send(API_KEY_ALREADY_REVOKED)
    return null
  }
  // Rotate and emergency-revoke both require the key to not already be in its rotation
  // overlap window — acting on a rotated-but-not-yet-expired key would silently issue a
  // second successor with no trace of the first rotation.
  if (oldKey.overlapExpiresAt !== null) {
    reply.status(409).send(API_KEY_ALREADY_ROTATED)
    return null
  }
  return oldKey
}

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

  // Story 7.2 AC-23: archival guard closure — same query hasActiveMachineUserKeys() delegates to.
  secureRoute(fastify, {
    method: 'GET',
    url: '/projects/:projectId/machine-users/active-keys',
    schema: { response: { 200: ActiveMachineUserKeysResponseSchema, ...READ_ERROR_RESPONSES } },
    security: READ_SECURITY,
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const projectExists = await findProjectInOrg(secureCtx.tx, params.projectId)
      if (!projectExists) return reply.status(404).send(PROJECT_NOT_FOUND)

      const items = await activeMachineUserKeysQuery(secureCtx.tx, params.projectId)
      return { data: { items, total: items.length } }
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

  // Story 8-6 AC-5: deactivate a machine user — idempotent, closes 7.1's forward-compatible-but-
  // unused `deactivatedAt` column. Existing keys stay individually revocable; new key issuance is
  // rejected below with 409 machine_user_deactivated.
  secureRoute(fastify, {
    method: 'POST',
    url: '/machine-users/:machineUserId/deactivate',
    schema: {
      response: {
        200: DeactivateMachineUserResponseSchema,
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
        key: 'POST /api/v1/machine-users/:machineUserId/deactivate',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(MachineUserParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      // Claim-via-UPDATE mirrors the revoke-api-key idempotency pattern above: at most one
      // concurrent caller ever transitions the row, and audit only fires on that transition.
      const deactivatedAt = new Date()
      const [claimed] = await secureCtx.tx
        .update(machineUsers)
        .set({ deactivatedAt })
        .where(and(eq(machineUsers.id, params.machineUserId), isNull(machineUsers.deactivatedAt)))
        .returning({ id: machineUsers.id, deactivatedAt: machineUsers.deactivatedAt })

      let result: { id: string; deactivatedAt: Date | null }
      if (claimed) {
        result = claimed
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          resourceType: 'machine_user',
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.MACHINE_USER_DEACTIVATED,
          resourceId: claimed.id,
          payload: {},
          request: req,
        })
      } else {
        const existing = await findMachineUserById(secureCtx.tx, params.machineUserId)
        if (!existing) return reply.status(404).send(MACHINE_USER_NOT_FOUND)
        result = existing
      }

      return {
        data: {
          id: result.id,
          deactivatedAt: (result.deactivatedAt ?? deactivatedAt).toISOString(),
        },
      }
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

  // AC-16/AC-17/AC-26: zero-downtime key rotation, row-locked to close the concurrent-rotation
  // TOCTOU window.
  secureRoute(fastify, {
    method: 'POST',
    url: '/machine-users/:machineUserId/api-keys/:keyId/rotate',
    schema: {
      body: RotateApiKeyBodySchema,
      response: {
        201: RotateApiKeyResponseSchema,
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
        key: 'POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/rotate',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ApiKeyParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(RotateApiKeyBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const oldKey = await lockAndRejectIfRevoked(secureCtx, params, reply)
      if (!oldKey) return reply

      const result = await rotateApiKey(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        machineUserId: params.machineUserId,
        oldKey,
        overlapMinutes: parsed.data.overlapMinutes,
      })

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'api_key',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.MACHINE_USER_API_KEY_ROTATED,
        resourceId: result.newKeyId,
        payload: {
          oldKeyId: oldKey.id,
          newKeyId: result.newKeyId,
          overlapMinutes: parsed.data.overlapMinutes,
        },
        request: req,
      })

      reply.status(201)
      return {
        data: {
          newKeyId: result.newKeyId,
          key: result.plaintext,
          oldKeyId: oldKey.id,
          overlapExpiresAt: result.overlapExpiresAt.toISOString(),
        },
      }
    },
  })

  // AC-20/AC-26: emergency revocation — atomic revoke-old + issue-new, no overlap window.
  secureRoute(fastify, {
    method: 'POST',
    url: '/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke',
    schema: {
      response: {
        200: EmergencyRevokeResponseSchema,
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
        key: 'POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ApiKeyParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const oldKey = await lockAndRejectIfRevoked(secureCtx, params, reply)
      if (!oldKey) return reply

      const result = await emergencyRevokeApiKey(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        machineUserId: params.machineUserId,
        oldKey,
      })

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'api_key',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.MACHINE_USER_API_KEY_EMERGENCY_REVOKED,
        resourceId: result.newKeyId,
        payload: { revokedKeyId: oldKey.id, newKeyId: result.newKeyId },
        request: req,
      })

      return {
        data: { revokedKeyId: oldKey.id, newKey: result.plaintext, newKeyId: result.newKeyId },
      }
    },
  })

  // AC-22: snoozes dormancy detection for a specific key without touching lastUsedAt.
  secureRoute(fastify, {
    method: 'POST',
    url: '/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy',
    schema: {
      body: ExtendDormancyBodySchema,
      response: {
        200: ExtendDormancyResponseSchema,
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
        key: 'POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ApiKeyParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(ExtendDormancyBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const dormancySnoozedUntil = new Date(Date.now() + parsed.data.days * 86_400_000)
      const [updated] = await secureCtx.tx
        .update(apiKeys)
        .set({ dormancySnoozedUntil })
        .where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.machineUserId, params.machineUserId)))
        .returning({ id: apiKeys.id })
      if (!updated) return reply.status(404).send(API_KEY_NOT_FOUND)

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'api_key',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.MACHINE_USER_DORMANCY_EXTENDED,
        resourceId: updated.id,
        payload: {
          keyId: updated.id,
          days: parsed.data.days,
          newSnoozeUntil: dormancySnoozedUntil.toISOString(),
        },
        request: req,
      })

      return {
        data: { keyId: updated.id, dormancySnoozedUntil: dormancySnoozedUntil.toISOString() },
      }
    },
  })
}
