import { and, eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Multipart } from '@fastify/multipart'
import { AuditEvent } from '@project-vault/shared'
import { projects } from '@project-vault/db/schema'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { defaultErrorResponses, ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { callerProjectRole } from '../projects/routes.js'
import {
  checkExportFormatVersion,
  decryptExportFile,
  importProjectBundle,
  parseExportBundle,
} from './import-service.js'
import { buildExportBundle, encryptBundleUnderExportKey, generateExportKey } from './service.js'
import { ExportProjectParamsSchema, ImportProjectResponseSchema } from './schema.js'

// Code review fix (28.9): the multipart `projectName` override previously reached
// `createProject()` (via `importProjectBundle`) as a bare string, bypassing the
// `min(1).max(128)` trimmed constraint every other project-creation caller goes through
// (`CreateProjectBodySchema.name` in ../projects/schema.ts) — the only project-creation path in
// the codebase that skipped it. Mirrored here rather than imported to avoid a cross-module
// schema dependency for one field.
const ImportProjectNameOverrideSchema = z.string().trim().min(1).max(128)

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const EXPORT_REQUIRES_ADMIN = {
  code: 'project_export_requires_admin',
  message: 'Exporting a project requires project admin/owner or org admin/owner authorization.',
} as const

// AC-10: conservative per-user limits for both potentially-expensive routes — full-project
// decrypt/re-encrypt on export, full-project insert-graph on import.
const EXPORT_RATE_LIMIT = {
  max: 5,
  timeWindowMs: 60 * 60 * 1000,
  key: 'POST /api/v1/projects/:projectId/export',
} as const
const IMPORT_RATE_LIMIT = {
  max: 5,
  timeWindowMs: 60 * 60 * 1000,
  key: 'POST /api/v1/projects/import',
} as const

// D3: a generous but bounded override of the app-wide 1 MB multipart default — a whole-project
// export (full secret-version history included) can legitimately exceed that.
const IMPORT_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024

async function callerCanExportProject(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<boolean> {
  const callerRole = await callerProjectRole(secureCtx, projectId)
  const isProjectAdminOrOwner = callerRole === 'admin' || callerRole === 'owner'
  const isOrgAdminOrOwner = secureCtx.auth.orgRole === 'admin' || secureCtx.auth.orgRole === 'owner'
  return isProjectAdminOrOwner || isOrgAdminOrOwner
}

function slugifyForFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug.slice(0, 64) : 'project'
}

type ImportUploadAccumulator = {
  fileBuffer: Buffer | null
  exportKey: string | null
  projectName: string | undefined
}

function sendUnknownFieldError(reply: FastifyReply): void {
  reply.status(422).send({ code: 'unknown_field', message: 'Unknown form field' })
}

/** Extracted from `readImportUpload` purely to keep that function's own cyclomatic/cognitive
 *  complexity under this repo's lint thresholds. Applies one multipart part to `acc`; returns
 *  `false` (reply already sent) when the part is rejected, `true` to keep iterating. */
async function applyImportUploadPart(
  part: Multipart,
  acc: ImportUploadAccumulator,
  reply: FastifyReply
): Promise<boolean> {
  if (part.type === 'file') {
    if (part.fieldname !== 'file' || acc.fileBuffer) {
      await part.toBuffer()
      sendUnknownFieldError(reply)
      return false
    }
    acc.fileBuffer = await part.toBuffer()
    return true
  }
  if (part.fieldname === 'exportKey' && typeof part.value === 'string') {
    acc.exportKey = part.value
    return true
  }
  if (part.fieldname === 'projectName' && typeof part.value === 'string') {
    const validated = ImportProjectNameOverrideSchema.safeParse(part.value)
    if (!validated.success) {
      reply.status(422).send({
        code: 'invalid_project_name',
        message: 'projectName must be 1-128 characters after trimming.',
      })
      return false
    }
    acc.projectName = validated.data
    return true
  }
  sendUnknownFieldError(reply)
  return false
}

async function readImportUpload(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ fileBuffer: Buffer; exportKey: string; projectName?: string } | null> {
  const acc: ImportUploadAccumulator = { fileBuffer: null, exportKey: null, projectName: undefined }
  try {
    for await (const part of req.parts({ limits: { fileSize: IMPORT_FILE_SIZE_LIMIT_BYTES } })) {
      if (!(await applyImportUploadPart(part, acc, reply))) return null
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      reply.status(422).send({
        code: 'file_too_large',
        message: 'Import file exceeds the maximum allowed size',
        limitBytes: IMPORT_FILE_SIZE_LIMIT_BYTES,
      })
      return null
    }
    throw error
  }

  const { fileBuffer, exportKey, projectName } = acc
  if (!fileBuffer || !exportKey) {
    reply.status(422).send({
      code: 'missing_fields',
      message: 'Both "file" and "exportKey" are required',
    })
    return null
  }
  return { fileBuffer, exportKey, ...(projectName ? { projectName } : {}) }
}

export async function projectExportRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/export',
    schema: {
      response: {
        200: z.string(),
        ...defaultErrorResponses,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      // Broad org-role floor — the real authorization is the in-handler project-admin/owner OR
      // org-admin/owner check (D4/AC-1), which is stricter than any single minimumRole value.
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: EXPORT_RATE_LIMIT,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ExportProjectParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const [project] = await secureCtx.tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, params.projectId), eq(projects.orgId, secureCtx.auth.orgId)))
        .limit(1)
      if (!project) return reply.status(404).send(PROJECT_NOT_FOUND)

      // AC-1 negative example: no key generated, no data read from credentials, when the caller
      // lacks authorization — checked before any export work begins.
      if (!(await callerCanExportProject(secureCtx, params.projectId))) {
        return reply.status(403).send(EXPORT_REQUIRES_ADMIN)
      }

      const rawExportKey = generateExportKey()
      const { bundle, counts } = await buildExportBundle(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
      })
      const encrypted = await encryptBundleUnderExportKey(bundle, rawExportKey)
      const fileBytes = Buffer.from(JSON.stringify(encrypted), 'utf8')

      // AC-2: entity counts only — never the key, never a decrypted value.
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_EXPORT_CREATED,
        resourceId: project.id,
        payload: counts,
        request: req,
      })

      const filename = `${slugifyForFilename(project.name)}-${new Date()
        .toISOString()
        .replace(/[:.]/g, '')}.pvexport`

      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      // Code review fix (28.9): this response carries the one-time X-Export-Key header
      // (real secret key material) alongside the encrypted bundle — explicitly ruling out any
      // intermediary (browser disk cache, corporate proxy, CDN) from persisting it, rather than
      // relying on "POST responses aren't usually cached" as the only protection.
      reply.header('Cache-Control', 'no-store')
      // D2: the ONLY place the raw key ever appears — the server holds no reference to it after
      // this response is sent.
      reply.header('X-Export-Key', rawExportKey)
      return reply.send(fileBytes)
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/import',
    schema: {
      response: {
        201: ImportProjectResponseSchema,
        422: ApiErrorSchema,
        ...defaultErrorResponses,
      },
    },
    security: {
      // D4: same floor as ordinary POST /projects — import is "create a project, then populate
      // it," never a stricter axis than plain project creation.
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: IMPORT_RATE_LIMIT,
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext

      // Code review fix (28.9): every rejected import — not just a bad decryption key — is
      // audited. This is precisely the AC-3 Red Team scenario (an attacker who already holds
      // the real export key probing with a malformed/oversized/corrupted payload) that AC-2's
      // audit trail exists to catch; the other failure branches previously returned an error
      // with no audit entry at all.
      const auditImportFailed = (reason: string): Promise<void> =>
        writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          resourceType: 'project',
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.PROJECT_IMPORT_FAILED,
          resourceId: secureCtx.auth.userId,
          payload: { reason },
          request: req,
        })

      const upload = await readImportUpload(req, reply)
      if (!upload) return reply

      const decrypted = await decryptExportFile(upload.fileBuffer, upload.exportKey)
      if (decrypted.status === 'decrypt_failed') {
        await auditImportFailed('decrypt_failed')
        return reply.status(401).send({
          code: 'import_decrypt_failed',
          message: 'The export file could not be decrypted with the supplied key.',
        })
      }

      let json: unknown
      try {
        json = JSON.parse(decrypted.plaintext)
      } catch {
        await auditImportFailed('invalid_json')
        return reply.status(422).send({
          code: 'invalid_export_payload',
          message: 'The decrypted export file is not valid JSON.',
        })
      }

      const versionCheck = checkExportFormatVersion(json)
      if (versionCheck.status === 'unsupported') {
        await auditImportFailed('unsupported_export_format')
        return reply.status(422).send({
          code: 'unsupported_export_format',
          message: `This export file was created with an incompatible version of Project Vault (format v${versionCheck.found}, this instance supports v1).`,
        })
      }

      const parsed = parseExportBundle(json)
      if (parsed.status === 'invalid_payload') {
        await auditImportFailed('invalid_export_payload')
        return reply.status(422).send({
          code: 'invalid_export_payload',
          message: 'The decrypted export file does not match the expected project export shape.',
        })
      }

      const result = await importProjectBundle(secureCtx, {
        bundle: parsed.bundle,
        ...(upload.projectName ? { projectNameOverride: upload.projectName } : {}),
        logger: req.log,
      })
      if (result.status === 'create_project_failed') {
        await auditImportFailed(`create_project_failed:${result.error.code}`)
        return reply.status(409).send(result.error)
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_IMPORT_COMPLETED,
        resourceId: result.projectId,
        payload: result.counts,
        request: req,
      })

      reply.status(201)
      return {
        data: { projectId: result.projectId, name: result.name, importedCounts: result.counts },
      }
    },
  })
}
