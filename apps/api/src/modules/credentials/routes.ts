import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  OperationalEvent,
  ImportValidationError,
  validateRotationCron,
} from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import {
  buildPaginationMeta,
  PAGE_OUT_OF_RANGE_ERROR,
  resolvePaginationOffset,
} from '../../lib/pagination.js'
import {
  roleRank,
  secureRoute,
  type AuditConfig,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import {
  callerCanSeeProject,
  effectiveProjectRole,
  logVisibilityDenied,
} from '../projects/project-access.js'
import {
  writeHumanAuditEntryOrFailClosed,
  type SameTransactionAuditInput,
} from '../../lib/audit-or-fail-closed.js'
import {
  AddVersionBodySchema,
  AddVersionResponseSchema,
  AddDependencyBodySchema,
  CreateCredentialBodySchema,
  CredentialAccessListResponseSchema,
  CredentialDetailResponseSchema,
  CredentialLifecycleResponseSchema,
  CredentialParamsSchema,
  CredentialValueResponseSchema,
  CredentialVersionListResponseSchema,
  DependencyArchivedResponseSchema,
  DependencyListResponseSchema,
  DependencyParamsSchema,
  DependencyResponseSchema,
  ListCredentialsQuerySchema,
  ListCredentialsResponseSchema,
  ListDependenciesQuerySchema,
  ImportConfirmBodySchema,
  ImportConfirmResponseSchema,
  ImportErrorResponseSchema,
  ImportPreviewResponseSchema,
  MAX_CREDENTIAL_LIST_OFFSET,
  ProjectScopeParamsSchema,
  TagArrayBodySchema,
  TagUpdateResponseSchema,
  UpdateCredentialLifecycleBodySchema,
  type AddVersionBody,
  type AddDependencyBody,
  type CreateCredentialBody,
  type TagArrayBody,
  type UpdateCredentialLifecycleBody,
  type ImportConfirmBody,
} from './schema.js'
import {
  VersionConflictError,
  addCredentialVersion,
  createCredentialWithFirstVersion,
  findProjectInOrg,
  getCredentialDetail,
  listCredentials,
  listVersionHistory,
  revealCurrentValue,
  updateCredentialTags,
} from './service.js'
import { FieldKeyConflictError } from './field-set.js'
import {
  addCredentialDependency,
  archiveCredentialDependency,
  listCredentialAccess,
  listCredentialDependencies,
  updateCredentialLifecycle,
} from './dependencies-service.js'
import {
  confirmCredentialImport,
  detectImportFileType,
  stageCredentialImport,
} from './import-service.js'
import { rejectIfProjectArchived } from '../projects/archive-guards.js'
import { credentialRevealAbandonedVersionExcludedTotal } from '../rotation/metrics.js'

type CredentialAuditInput = Omit<SameTransactionAuditInput, 'resourceType'> & {
  eventType:
    | 'credential.created'
    | 'credential.version_created'
    | 'credential.value_revealed'
    | 'credential.tags_updated'
    | 'credential.dependency_added'
    | 'credential.dependency_archived'
    | 'credential.lifecycle_updated'
}

type ImportAuditRequest = FastifyRequest & {
  importAuditPayload?: Record<string, unknown>
}

async function writeImportBatchAudit({
  tx,
  auth,
  request,
  config,
}: {
  tx: Tx
  auth: SecureRouteContext['auth']
  request: FastifyRequest
  config: AuditConfig
}): Promise<void> {
  const params = request.params as Record<string, unknown>
  const resourceId =
    config.resourceIdFromParams && typeof params[config.resourceIdFromParams] === 'string'
      ? (params[config.resourceIdFromParams] as string)
      : undefined
  if (config.resourceIdFromParams && !resourceId) {
    throw new Error(`SecureRoute: missing audit resourceId param "${config.resourceIdFromParams}"`)
  }
  const payload = (request as ImportAuditRequest).importAuditPayload ?? {}
  await writeHumanAuditEntryOrFailClosed(tx, {
    resourceType: config.resourceType ?? 'project',
    orgId: auth.orgId,
    actorUserId: auth.userId,
    eventType: config.eventType,
    resourceId: resourceId as string,
    payload,
    request,
  })
}

async function readImportUpload(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ filename: string; content: string } | null> {
  let upload: { filename: string; content: string } | null = null
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || upload) {
          await part.toBuffer()
          reply.status(422).send({ code: 'unknown_field', message: 'Unknown form field' })
          return null
        }
        if (!part.filename) {
          await part.toBuffer()
          reply.status(422).send({
            code: 'missing_filename',
            message: 'File must have a filename to determine its type',
          })
          return null
        }
        const buffer = await part.toBuffer()
        upload = { filename: part.filename, content: buffer.toString('utf8') }
        continue
      }
      reply.status(422).send({ code: 'unknown_field', message: 'Unknown form field' })
      return null
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      reply.status(422).send({
        code: 'file_too_large',
        message: 'Import file must be 1 MB or smaller',
        limitBytes: 1_048_576,
      })
      return null
    }
    throw error
  }

  if (!upload) {
    reply.status(422).send({
      code: 'missing_filename',
      message: 'File must have a filename to determine its type',
    })
    return null
  }

  return upload
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
const INSUFFICIENT_PROJECT_ROLE = {
  code: 'insufficient_project_role',
  message: 'Your role in this project does not permit revealing credential values',
} as const
const CREDENTIAL_REVEAL_FAILED_MESSAGE = 'Credential value reveal failed'
const CREDENTIAL_SUBRESOURCE_READ_ERRORS = {
  401: ApiErrorSchema,
  404: ApiErrorSchema,
  422: ApiErrorSchema,
} as const

/**
 * Story 4.5 AC-V4/AC-V10: shared visibility gate. Returns true when the reply was already sent
 * (404 + structured visibility_denied log), so callers can `if (await reject...) return reply`.
 */
async function rejectIfProjectNotVisible(
  secureCtx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  notFoundBody: typeof PROJECT_NOT_FOUND | typeof CREDENTIAL_NOT_FOUND = PROJECT_NOT_FOUND
): Promise<boolean> {
  if (await callerCanSeeProject(secureCtx, projectId)) return false
  logVisibilityDenied(req, {
    projectId,
    callerId: secureCtx.auth.userId,
    orgRole: secureCtx.auth.orgRole,
  })
  reply.status(404).send(notFoundBody)
  return true
}

/** Story 4.5 AC-P2/AC-P3: value reveal + version create require effective role >= member. */
async function rejectIfInsufficientProjectRoleForReveal(
  secureCtx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  credentialId: string,
  kind: 'reveal' | 'version_create'
): Promise<boolean> {
  const effective = await effectiveProjectRole(secureCtx, projectId)
  if (roleRank(effective) >= roleRank('member')) return false
  if (kind === 'reveal') {
    req.log.warn(
      {
        eventType: OperationalEvent.CREDENTIAL_REVEAL_FAILURE,
        orgId: secureCtx.auth.orgId,
        credentialId,
        reason: 'insufficient_project_role',
      },
      CREDENTIAL_REVEAL_FAILED_MESSAGE
    )
  } else {
    req.log.warn(
      {
        eventType: 'credential.version_create_denied',
        orgId: secureCtx.auth.orgId,
        credentialId,
        projectId,
        callerId: secureCtx.auth.userId,
        reason: 'insufficient_project_role',
      },
      'Credential version create denied by project role'
    )
  }
  reply.status(403).send(INSUFFICIENT_PROJECT_ROLE)
  return true
}

/**
 * Story 4.5 AC-V4: combines the visibility gate with the existing archived-project guard for
 * mutation routes, keeping each individual handler's own branching count low.
 */
async function rejectIfCredentialLifecycleUpdateBlocked(
  secureCtx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string
): Promise<boolean> {
  if (await rejectIfProjectNotVisible(secureCtx, req, reply, projectId, CREDENTIAL_NOT_FOUND))
    return true
  return rejectIfProjectArchived(secureCtx.tx, projectId, reply)
}
// Story 13.2 AC-3 — a field-key collision (case-insensitive) is surfaced with the conflicting key
// so the web can attach an inline error to the specific field being renamed/added.
function fieldKeyConflictResponse(error: FieldKeyConflictError) {
  return {
    code: 'field_key_conflict' as const,
    message: `A field named "${error.conflictingKey}" already exists on this secret`,
  }
}

// Story 13.2 AC-3/AC-9 — wraps a create/edit field-set write, mapping a field-key collision or a
// concurrent-version conflict to a 409 (with no audit event, since the throw precedes the audit
// write). Shared by the create and version-create handlers so the 409 mapping lives in one place.
async function runCredentialFieldSetWrite<T>(
  reply: FastifyReply,
  run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    if (error instanceof FieldKeyConflictError) {
      reply.status(409).send(fieldKeyConflictResponse(error))
      return { ok: false }
    }
    if (error instanceof VersionConflictError) {
      reply.status(409).send({ code: 'version_conflict', message: error.message })
      return { ok: false }
    }
    throw error
  }
}

const DEPENDENCY_NOT_FOUND = {
  code: 'dependency_not_found',
  message: 'Dependency not found',
} as const
const TOO_MANY_TAGS = {
  code: 'too_many_tags',
  message: 'A credential may have at most 20 tags',
} as const

// Extracted purely to keep the lifecycle-PATCH handler's cyclomatic complexity under the repo's
// eslint threshold once the 4.4 archived-project guard was added; behavior unchanged.
function hasNoLifecycleUpdateFields(rawBody: Record<string, unknown>): boolean {
  return !('expiresAt' in rawBody) && !('rotationSchedule' in rawBody) && !('cacheable' in rawBody)
}

function invalidRotationScheduleResponse(reason: 'unparseable' | 'too_frequent'): {
  code: 'invalid_cron'
  message: string
} {
  return {
    code: 'invalid_cron',
    message:
      reason === 'too_frequent'
        ? 'Rotation schedule may run at most once per hour'
        : 'Invalid cron expression',
  }
}

function rejectInvalidRotationSchedule(
  schedule: unknown,
  reply: FastifyReply,
  logContext?: { req: FastifyRequest; orgId: string; credentialId?: string }
): schedule is string {
  if (typeof schedule !== 'string') return true
  const res = validateRotationCron(schedule)
  if (res.ok) return true
  if (logContext) {
    logContext.req.log.info(
      {
        eventType: OperationalEvent.CREDENTIAL_LIFECYCLE_INVALID_CRON,
        orgId: logContext.orgId,
        credentialId: logContext.credentialId,
        reason: res.reason,
      },
      'Invalid rotation schedule rejected'
    )
  }
  reply.status(422).send(invalidRotationScheduleResponse(res.reason))
  return false
}

const CREDENTIAL_TAG_ROUTE_SCHEMA = {
  response: {
    200: TagUpdateResponseSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    410: ApiErrorSchema,
    422: ApiErrorSchema,
  },
} as const

function credentialTagRouteSecurity(method: 'PUT' | 'PATCH') {
  return {
    minimumRole: 'member' as const,
    rateLimit: {
      max: 60,
      timeWindowMs: 60_000,
      key: `${method} /api/v1/projects/:projectId/credentials/:credentialId/tags`,
    },
    writeAuditEvent: false,
  }
}

async function handleCredentialTagUpdate(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  mode: 'replace' | 'append'
) {
  const params = parseParams(CredentialParamsSchema, req, reply)
  if (!params) return reply
  const parsed = parseBody<TagArrayBody>(TagArrayBodySchema, req, reply)
  if (!parsed.success) return reply
  const secureCtx = ctx as SecureRouteContext

  if (
    await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId, CREDENTIAL_NOT_FOUND)
  )
    return reply

  // 4.4 AC-5: credential tags are a mutation of an existing resource within the project.
  if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

  const result = await updateCredentialTags(secureCtx.tx, {
    ...params,
    body: parsed.data,
    mode,
  })
  if (result.status === 'not_found') return reply.status(404).send(CREDENTIAL_NOT_FOUND)
  if (result.status === 'too_many_tags') {
    return reply.status(422).send(TOO_MANY_TAGS)
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
}

async function withCredentialParams<T>(
  ctx: PublicRouteContext | SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  run: (
    secureCtx: SecureRouteContext,
    params: { projectId: string; credentialId: string }
  ) => Promise<T | null>,
  opts?: { checkVisibility?: boolean }
) {
  const params = parseParams(CredentialParamsSchema, req, reply)
  if (!params) return reply
  const secureCtx = ctx as SecureRouteContext
  if (
    opts?.checkVisibility !== false &&
    (await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId, CREDENTIAL_NOT_FOUND))
  ) {
    return reply
  }
  const result = await run(secureCtx, params)
  if (result === null) return reply.status(404).send(CREDENTIAL_NOT_FOUND)
  return result
}

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
      if (await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId)) return reply
      const projectExists = await findProjectInOrg(secureCtx.tx, params.projectId)
      if (!projectExists) return reply.status(404).send(PROJECT_NOT_FOUND)

      const resolved = resolvePaginationOffset(
        parsedQuery.data.page,
        parsedQuery.data.limit,
        MAX_CREDENTIAL_LIST_OFFSET
      )
      if (!resolved) return reply.status(422).send(PAGE_OUT_OF_RANGE_ERROR)
      const { pagination, offset } = resolved

      const { items, total } = await listCredentials(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
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
        409: ApiErrorSchema,
        410: ApiErrorSchema,
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
      if (await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId)) return reply
      if (
        !rejectInvalidRotationSchedule(parsed.data.rotationSchedule, reply, {
          req,
          orgId: secureCtx.auth.orgId,
        })
      ) {
        return reply
      }

      // 4.4 AC-5: reject new credentials on an archived project with 410 before the generic
      // findProjectInOrg 404 check (which itself excludes archived rows, but 410 is more precise
      // than conflating "archived" with "does not exist").
      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const projectExists = await findProjectInOrg(secureCtx.tx, params.projectId)
      if (!projectExists) return reply.status(404).send(PROJECT_NOT_FOUND)

      const created = await runCredentialFieldSetWrite(reply, () =>
        createCredentialWithFirstVersion(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          userId: secureCtx.auth.userId,
          body: parsed.data,
        })
      )
      if (!created.ok) return reply
      const { credential, detail } = created.value

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
    url: '/:projectId/credentials/import',
    schema: {
      response: {
        201: ImportPreviewResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ImportErrorResponseSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: false,
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/import',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      if (await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId)) return reply

      // 4.4 AC-5: bulk import staging must not proceed against an archived project — otherwise a
      // caller could still walk through the import flow to /confirm afterward.
      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const upload = await readImportUpload(req, reply)
      if (!upload) return reply

      const fileType = detectImportFileType(upload.filename)
      if (fileType === 'unsupported') {
        return reply.status(422).send({
          code: 'unsupported_file_type',
          message: 'Only .env and .json files are supported',
          supportedExtensions: ['.env', '.json'],
        })
      }

      let staged
      try {
        staged = await stageCredentialImport(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          userId: secureCtx.auth.userId,
          fileType,
          content: upload.content,
        })
      } catch (error) {
        if (error instanceof ImportValidationError) {
          return reply.status(422).send({ code: error.code, message: error.message })
        }
        throw error
      }

      if (staged.status === 'project_not_found') {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }
      if (staged.status === 'too_large') {
        return reply.status(422).send({
          code: 'import_too_large',
          message: 'Import file contains too many credentials',
          limit: 500,
          found: staged.found,
        })
      }

      const { preview } = staged
      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_IMPORT_PARSE_COMPLETED,
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          fileType: preview.operational.fileType,
          itemCount: preview.itemCount,
          warningCount: preview.operational.warningCount,
          conflictCount: preview.operational.conflictCount,
        },
        'Credential import parse completed'
      )
      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_IMPORT_ENCRYPTED,
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          importId: preview.importId,
          itemCount: preview.itemCount,
        },
        'Credential import values encrypted'
      )

      ;(req as ImportAuditRequest).importAuditPayload = preview.auditPayload
      await writeImportBatchAudit({
        tx: secureCtx.tx,
        auth: secureCtx.auth,
        request: req,
        config: {
          eventType: 'credential.bulk_import_initiated',
          resourceType: 'project',
          resourceIdFromParams: 'projectId',
        },
      })
      reply.status(201)
      return { data: preview }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/import/confirm',
    schema: {
      body: ImportConfirmBodySchema,
      response: {
        200: ImportConfirmResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ImportErrorResponseSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: false,
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/import/confirm',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<ImportConfirmBody>(ImportConfirmBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext
      if (await rejectIfProjectNotVisible(secureCtx, req, reply, params.projectId)) return reply

      // 4.4 AC-5: this is the step that actually inserts credential rows — an archived project
      // must not gain new credentials via the bulk-import confirm path either.
      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const confirmed = await confirmCredentialImport(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        importId: parsed.data.importId,
        defaultAction: parsed.data.defaultAction,
        overrides: parsed.data.overrides,
      })

      if (confirmed.status === 'not_found') {
        return reply.status(404).send({
          code: 'import_not_found',
          message: 'Import not found',
        })
      }
      if (confirmed.status === 'expired') {
        req.log.info(
          {
            eventType: OperationalEvent.CREDENTIAL_IMPORT_EXPIRED_ON_CONFIRM,
            orgId: secureCtx.auth.orgId,
            projectId: params.projectId,
            importId: parsed.data.importId,
          },
          'Credential import expired on confirm'
        )
        return reply.status(410).send({
          code: 'import_expired',
          message: 'Import preview has expired. Please upload the file again.',
          expiredAt: confirmed.expiredAt,
        })
      }

      for (const audit of confirmed.perCredentialAudits) {
        await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: audit.eventType,
          resourceId: audit.resourceId,
          payload: audit.payload,
          request: req,
        })
      }

      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_IMPORT_CONFIRMED,
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          importId: confirmed.result.auditPayload.importId,
          imported: confirmed.result.imported,
          newVersions: confirmed.result.newVersions,
          skipped: confirmed.result.skipped,
        },
        'Credential import confirmed'
      )

      ;(req as ImportAuditRequest).importAuditPayload = confirmed.result.auditPayload
      await writeImportBatchAudit({
        tx: secureCtx.tx,
        auth: secureCtx.auth,
        request: req,
        config: {
          eventType: 'credential.bulk_import_confirmed',
          resourceType: 'project',
          resourceIdFromParams: 'projectId',
        },
      })
      return { data: confirmed.result }
    },
  })

  secureRoute(fastify, {
    method: 'PUT',
    url: '/:projectId/credentials/:credentialId/tags',
    schema: CREDENTIAL_TAG_ROUTE_SCHEMA,
    security: credentialTagRouteSecurity('PUT'),
    handler: async (ctx, req, reply) => handleCredentialTagUpdate(ctx, req, reply, 'replace'),
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId/credentials/:credentialId/tags',
    schema: CREDENTIAL_TAG_ROUTE_SCHEMA,
    security: credentialTagRouteSecurity('PATCH'),
    handler: async (ctx, req, reply) => handleCredentialTagUpdate(ctx, req, reply, 'append'),
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId',
    schema: {
      response: {
        200: CredentialDetailResponseSchema,
        ...CREDENTIAL_SUBRESOURCE_READ_ERRORS,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) =>
      withCredentialParams(ctx, req, reply, async (secureCtx, params) => {
        const detail = await getCredentialDetail(secureCtx.tx, params)
        return detail ? { data: detail } : null
      }),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/versions',
    schema: {
      response: {
        201: AddVersionResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
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
      if (
        await rejectIfProjectNotVisible(
          secureCtx,
          req,
          reply,
          params.projectId,
          CREDENTIAL_NOT_FOUND
        )
      )
        return reply

      // Story 4.5 AC-P3/D4: value reveal + version creation both require effective role >=
      // member — runs after the visibility gate above, before any mutation.
      if (
        await rejectIfInsufficientProjectRoleForReveal(
          secureCtx,
          req,
          reply,
          params.projectId,
          params.credentialId,
          'version_create'
        )
      )
        return reply

      // 4.4 AC-5: rotating a credential mutates an existing resource — "read-only" covers this,
      // not just creation of brand-new credentials.
      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const outcome = await runCredentialFieldSetWrite(reply, () =>
        addCredentialVersion(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          projectId: params.projectId,
          userId: secureCtx.auth.userId,
          body: parsed.data,
        })
      )
      if (!outcome.ok) return reply
      if (!outcome.value) return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      const { version, auditPayload } = outcome.value

      // Story 13.2 AC-9 — the audit event names the changed field keys (added/removed) and template,
      // never any plaintext value; only written on a successful field-set version write.
      await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.version_created',
        resourceId: params.credentialId,
        payload: auditPayload,
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
        403: ApiErrorSchema,
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
      if (
        await rejectIfProjectNotVisible(
          secureCtx,
          req,
          reply,
          params.projectId,
          CREDENTIAL_NOT_FOUND
        )
      )
        return reply

      // Story 4.5 AC-P2/D4: runs after the visibility gate, strictly before the reveal-attempt
      // log below, so a project-role-denied attempt is never misleadingly logged as a real one.
      if (
        await rejectIfInsufficientProjectRoleForReveal(
          secureCtx,
          req,
          reply,
          params.projectId,
          params.credentialId,
          'reveal'
        )
      )
        return reply

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

      // Story 5.5 AC-3: revealCurrentValue() excluding an abandoned version to serve an earlier
      // one is Story 5.3's own self-described "single highest-risk change" — this is the
      // production visibility a regression in that filter would otherwise lack.
      if (revealed.abandonedVersionExcluded) {
        credentialRevealAbandonedVersionExcludedTotal.inc()
        req.log.warn(
          {
            eventType: OperationalEvent.CREDENTIAL_REVEAL_ABANDONED_VERSION_EXCLUDED,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            servedVersionNumber: revealed.versionNumber,
          },
          'Credential value reveal excluded an abandoned version to serve an earlier one'
        )
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
        ...CREDENTIAL_SUBRESOURCE_READ_ERRORS,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) =>
      withCredentialParams(ctx, req, reply, async (secureCtx, params) => {
        const items = await listVersionHistory(secureCtx.tx, params)
        return items ? { data: { items } } : null
      }),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/dependencies',
    schema: {
      response: {
        201: DependencyResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      requireMfa: false,
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/dependencies',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<AddDependencyBody>(AddDependencyBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext
      if (await rejectIfCredentialLifecycleUpdateBlocked(secureCtx, req, reply, params.projectId))
        return reply

      const result = await addCredentialDependency(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        userId: secureCtx.auth.userId,
        ...params,
        body: parsed.data,
      })
      if (result.status === 'not_found') return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      if (result.status === 'too_many') {
        return reply.status(422).send({
          code: 'too_many_dependencies',
          message: 'A credential may have at most 200 active dependencies',
        })
      }

      await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.dependency_added',
        resourceId: params.credentialId,
        payload: {
          dependencyId: result.dependency.id,
          systemName: result.dependency.systemName,
          systemType: result.dependency.systemType,
        },
        request: req,
      })

      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_DEPENDENCY_ADDED,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          dependencyId: result.dependency.id,
          systemType: result.dependency.systemType,
        },
        'Credential dependency added'
      )

      reply.status(201)
      return { data: result.dependency }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/dependencies',
    schema: {
      response: {
        200: DependencyListResponseSchema,
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
        key: 'GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies',
      },
    },
    handler: async (ctx, req, reply) => {
      const parsedQuery = ListDependenciesQuerySchema.safeParse(req.query)
      if (!parsedQuery.success) {
        return reply.status(422).send(validationError(parsedQuery.error, 'query'))
      }
      return withCredentialParams(ctx, req, reply, async (secureCtx, params) => {
        const result = await listCredentialDependencies(secureCtx.tx, {
          ...params,
          query: parsedQuery.data,
        })
        // Must wrap as `{ data: result }` to match DependencyListResponseSchema — the 4-5
        // jscpd extract to withCredentialParams dropped this wrapper and Fastify then 500'd
        // on response-schema validation (Story 2.9 Group D depends on this GET; independently
        // rediscovered and fixed identically by Story 10-1's real-browser E2E run, which hit
        // the same FST_ERR_RESPONSE_SERIALIZATION 500 via AC-J1-1's credential detail page load).
        return result ? { data: result } : null
      })
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/:projectId/credentials/:credentialId/dependencies/:dependencyId',
    schema: {
      response: {
        200: DependencyArchivedResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(DependencyParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      if (await rejectIfCredentialLifecycleUpdateBlocked(secureCtx, req, reply, params.projectId))
        return reply

      const result = await archiveCredentialDependency(secureCtx.tx, {
        userId: secureCtx.auth.userId,
        credentialId: params.credentialId,
        projectId: params.projectId,
        dependencyId: params.dependencyId,
      })
      if (result.status === 'credential_not_found') {
        return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      }
      if (result.status === 'dependency_not_found') {
        return reply.status(404).send(DEPENDENCY_NOT_FOUND)
      }

      if (result.status === 'archived') {
        await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: 'credential.dependency_archived',
          resourceId: params.credentialId,
          payload: result.auditPayload,
          request: req,
        })
        req.log.info(
          {
            eventType: OperationalEvent.CREDENTIAL_DEPENDENCY_ARCHIVED,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            dependencyId: params.dependencyId,
          },
          'Credential dependency archived'
        )
      }

      return { data: result.data }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId/credentials/:credentialId',
    schema: {
      response: {
        200: CredentialLifecycleResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'PATCH /api/v1/projects/:projectId/credentials/:credentialId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialParamsSchema, req, reply)
      if (!params) return reply
      const rawBody =
        req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
      if (hasNoLifecycleUpdateFields(rawBody)) {
        return reply.status(422).send({
          code: 'no_fields_to_update',
          message: 'Provide expiresAt, rotationSchedule, and/or cacheable',
        })
      }
      const secureCtx = ctx as SecureRouteContext
      // 4.4 AC-5: editing a credential's lifecycle fields mutates an existing resource — the same
      // rationale used to guard the versions/rotate route applies here.
      if (await rejectIfCredentialLifecycleUpdateBlocked(secureCtx, req, reply, params.projectId))
        return reply

      if (
        !rejectInvalidRotationSchedule(rawBody.rotationSchedule, reply, {
          req,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
        })
      ) {
        return reply
      }
      const parsed = parseBody<UpdateCredentialLifecycleBody>(
        UpdateCredentialLifecycleBodySchema,
        req,
        reply
      )
      if (!parsed.success) return reply

      const result = await updateCredentialLifecycle(secureCtx.tx, {
        ...params,
        body: parsed.data,
        rawBody,
      })
      if (!result) return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      if (result.status === 'unchanged') return { data: result.data }

      await writeCredentialAuditOrFailClosed(req, secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.lifecycle_updated',
        resourceId: params.credentialId,
        payload: result.auditPayload,
        request: req,
      })
      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_LIFECYCLE_UPDATED,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          changed: result.auditPayload.changed,
        },
        'Credential lifecycle updated'
      )
      return { data: result.data }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/access',
    schema: {
      response: {
        200: CredentialAccessListResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      writeAuditEvent: false,
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/projects/:projectId/credentials/:credentialId/access',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const items = await listCredentialAccess(secureCtx.tx, {
        ...params,
        orgId: secureCtx.auth.orgId,
      })
      if (!items) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      return { data: { items } }
    },
  })
}
