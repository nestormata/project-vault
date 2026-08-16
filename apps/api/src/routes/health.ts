import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { z } from 'zod/v4'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../lib/fastify-app.js'
import { getVaultStatus } from '../modules/vault/key-service.js'
import { getExtensionsHealthField } from '../extensions/loader.js'
import { getThemesHealthField } from '../modules/theming/service.js'
import { getReleaseVersion } from '../lib/package-version.js'
import { isNativeLoginEnabled } from '../modules/auth/native-login-policy.js'

// Story 14.2 AC-1/2/3/6: additive field, always present, never causes /health to deviate from
// its existing unconditional-200 liveness contract — extension state is informational only.
// Story 16.1 AC-9: themesLoaded/themesFailed are simple counts only (never filenames/reasons —
// this is a public, unauthenticated endpoint) so a fresh boot before the startup reload pass
// completes still reports a well-formed 0/0 shape, never null/undefined.
// Story 9.10 AC-1: versionSource distinguishes a real injected RELEASE_VERSION ('release') from
// the documented dev fallback ('development') so callers (e.g. Version & Upgrade) never present
// a local/untagged build as a production release.
const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  versionSource: z.enum(['release', 'development']),
  extensions_status: z.enum(['not_configured', 'loaded', 'load_failed']),
  themesLoaded: z.number().int().nonnegative(),
  themesFailed: z.number().int().nonnegative(),
  // Story 23.2 AC-13: the one field the login screen actually reads to decide whether to render
  // the password form at all — before the user has typed anything, so it cannot live behind
  // POST /auth/domain-lookup (which requires an email). Boot-resolved, in-process, zero DB reads
  // (see native-login-policy.ts's module-level `resolved` object) — reading it here is exactly
  // as cheap as extensions_status above.
  nativeLoginEnabled: z.boolean(),
})

const ReadyResponseSchema = z.object({
  status: z.literal('ready'),
  warnings: z.array(z.string()).optional(),
})

const ReadyUnavailableResponseSchema = z.union([
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(['uninitialized', 'sealed']),
    message: z.string(),
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.literal('db'),
    retryAfter: z.number().int().positive(),
  }),
])

type DbPool = {
  query: (sql: string) => Promise<unknown>
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { message: String(err) }
}

/**
 * Story 9.2 AC-18: additive, optional `warnings` array — never changes `status` away from
 * `"ready"` for these two conditions (they are warnings, not outages, contrasting with the
 * existing `"sealed"`/`"uninitialized"`/`"db"` reasons above, which already return 503). A
 * best-effort lookup failure here must not fail /ready itself — /ready's core contract (DB
 * reachable, vault unsealed) already succeeded by the time this is called.
 */
async function resolveReadyWarnings(dbPool: DbPool): Promise<string[]> {
  try {
    const rows = (await dbPool.query(
      `SELECT alert_type FROM admin_alerts WHERE status = 'active' AND alert_type IN ('audit_storage.critical', 'key_custody_risk')`
    )) as { alert_type: string }[]
    const activeTypes = new Set(rows.map((row) => row.alert_type))
    const warnings: string[] = []
    if (activeTypes.has('audit_storage.critical')) warnings.push('audit_storage_critical')
    if (activeTypes.has('key_custody_risk')) warnings.push('key_custody_risk')
    return warnings
  } catch {
    return []
  }
}

export async function healthRoutes(
  fastify: FastifyApp,
  options: { dbPool?: DbPool }
): Promise<void> {
  fastify.route({
    method: 'GET',
    url: '/health',
    schema: {
      response: {
        200: HealthResponseSchema,
      },
    },
    handler: async (_req: FastifyRequest, reply: FastifyReply) => {
      const themesHealth = getThemesHealthField()
      // Story 9.10 AC-1/AC-4: resolved per-request (not cached at module load) so a
      // RELEASE_VERSION set only for tests, or a future hot-reload scenario, is always
      // reflected — cheap env-var read, no .git/network access.
      const release = getReleaseVersion()
      return reply.send({
        status: 'ok',
        version: release.version,
        versionSource: release.isRelease ? 'release' : 'development',
        extensions_status: getExtensionsHealthField(),
        themesLoaded: themesHealth.themesLoaded,
        themesFailed: themesHealth.themesFailed,
        nativeLoginEnabled: isNativeLoginEnabled(),
      })
    },
  })

  fastify.route({
    method: 'GET',
    url: '/ready',
    schema: {
      response: {
        200: ReadyResponseSchema,
        503: ReadyUnavailableResponseSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const vaultStatus = getVaultStatus()

      if (vaultStatus === 'uninitialized') {
        return reply.status(503).send({
          status: 'unavailable',
          reason: 'uninitialized',
          message: 'Vault not initialized. POST /api/v1/vault/init to initialize.',
        })
      }

      if (vaultStatus === 'sealed') {
        return reply.status(503).send({
          status: 'unavailable',
          reason: 'sealed',
          message: 'Manual unseal required via POST /api/v1/vault/unseal',
        })
      }

      if (!options.dbPool) {
        return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
      }

      try {
        await options.dbPool.query('SELECT 1')
        const warnings = await resolveReadyWarnings(options.dbPool)
        return reply.send(warnings.length > 0 ? { status: 'ready', warnings } : { status: 'ready' })
      } catch (err) {
        req.log.error(
          { eventType: OperationalEvent.DB_ERROR, err: serializeError(err) },
          'Database query failed'
        )
        return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
      }
    },
  })
}
