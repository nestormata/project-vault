import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../lib/fastify-app.js'
import { ApiErrorSchema } from '../lib/api-contracts.js'
import { secureRoute } from '../lib/secure-route.js'
import { getExtensionStatus } from './loader.js'
import { getNativeLoginPolicyState } from '../modules/auth/native-login-policy.js'
import { countLiveSessionsAcrossInstance } from './sessions-live-count.js'

// AC-2/AC-4: OrgAdmin sees the loaded manifest, or a real `null` (not 404, not `{}`) when
// nothing is loaded — a future admin UI page's honest empty state (Product Surface Contract).
const ExtensionManifestSchema = z.object({
  name: z.string(),
  apiVersion: z.string(),
  capabilities: z.array(z.enum(['auth-provider', 'notification-channel', 'ui-panel'])),
  loadedAt: z.string(),
})

// Story 23.2 AC-12: "the active policy is observable." Deliberately BREAKS the pre-existing bare
// manifest-or-null response shape into an envelope, in the same commit as this route's own
// updated tests, packages/api-contract-tests's conformance suite, and the regenerated
// packages/shared/openapi.json — there is no dual-shape transition period. `nativeLoginPolicy`
// mirrors `NativeLoginPolicyDiagnostics` (native-login-policy.ts) exactly, plus one extra field
// (`sessionsLive`) that diagnostics itself deliberately does NOT carry (diagnostics is read at
// boot with no DB access; this route is the one place a DB read for it is allowed — see
// sessions-live-count.ts). `preExclusionSessionsLive`/`preExclusionSessionsLastExpiresAt` from
// the original story text are NOT implemented here: AC-12 states they are uncomputable (no
// snapshot is taken at the moment of exclusion), and this is the corrected shape.
const NativeLoginPolicySchema = z.object({
  enabled: z.boolean(),
  state: z.enum(['enabled', 'replacement_declared_unproven', 'disabled', 'break_glass']),
  replacementDeclared: z.boolean(),
  replacementProven: z.boolean(),
  replacementProvenAt: z.string().nullable(),
  appliedAtBoot: z.boolean(),
  breakGlassActive: z.boolean(),
  replacementConfirmedOverride: z.boolean(),
  extensionStatus: z.enum(['not_configured', 'loaded', 'load_failed']),
  extensionFailureReason: z.string().nullable(),
  sessionsLive: z.number().int().nonnegative(),
})

const ExtensionStatusEnvelopeSchema = z.object({
  extension: ExtensionManifestSchema.nullable(),
  nativeLoginPolicy: NativeLoginPolicySchema,
})

export async function extensionStatusRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/extensions/status',
    schema: {
      response: {
        200: ExtensionStatusEnvelopeSchema,
        // AC-5 / secure-route.ts: 401 (unauthenticated) and 403 (authenticated but not org-role
        // 'admin' — including 'owner', see the Dev Notes comment below) are both real, tested
        // outcomes for this route, not schema-less framework fallthrough — document them like
        // every other secureRoute()-gated route in this codebase (e.g.
        // modules/platform-admin/route-common.ts's PLATFORM_ADMIN_ERROR_RESPONSES) so the
        // generated OpenAPI spec — and packages/api-contract-tests's AC-9 conformance suite —
        // reflect the contract this route actually has.
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
    security: {
      // Dev Notes: epics.md/architecture.md's "OrgAdmin" maps 1:1 to this codebase's literal
      // `'admin'` org role — not `['owner', 'admin']` (see AC-5, secure-route.ts's
      // `allowedRoles` semantics).
      allowedRoles: ['admin'],
      requireMfa: true,
      // A read-only status check does not itself need its own audit event — only the *load*
      // (AuditEvent.EXTENSION_LOADED/EXTENSION_LOAD_FAILED, written by loader.ts) is audited.
      writeAuditEvent: false,
    },
    handler: async (_ctx, _req: FastifyRequest, _reply: FastifyReply) => {
      const status = getExtensionStatus()
      const policy = getNativeLoginPolicyState()
      const sessionsLive = await countLiveSessionsAcrossInstance()

      return {
        extension:
          status.status === 'loaded'
            ? {
                name: status.manifest.name,
                apiVersion: status.manifest.apiVersion,
                capabilities: status.manifest.capabilities,
                loadedAt: status.loadedAt,
              }
            : null,
        nativeLoginPolicy: { ...policy, sessionsLive },
      }
    },
  })
}
