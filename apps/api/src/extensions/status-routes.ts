import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../lib/fastify-app.js'
import { ApiErrorSchema } from '../lib/api-contracts.js'
import { secureRoute } from '../lib/secure-route.js'
import { getExtensionStatus } from './loader.js'
import { getNativeLoginPolicyState } from '../modules/auth/native-login-policy.js'
import {
  isLatchProvenForExtension,
  readReplacementLatch,
} from '../modules/auth/native-login-latch.js'
import { countLiveSessionsAcrossInstance } from './sessions-live-count.js'

// AC-2/AC-4: OrgAdmin sees the loaded manifest, or a real `null` (not 404, not `{}`) when
// nothing is loaded — a future admin UI page's honest empty state (Product Surface Contract).
const ExtensionManifestSchema = z.object({
  name: z.string(),
  apiVersion: z.string(),
  capabilities: z.array(
    z.enum([
      'auth-provider',
      'notification-channel',
      'ui-panel',
      'capability-gate',
      'audit-event-source',
      'project-lifecycle',
    ])
  ),
  loadedAt: z.string(),
  // Story 25.9 AC4: the loaded package's own release version (its `package.json` `version`
  // field), distinct from `apiVersion` above (the extension-API *contract* version). `null` — not
  // omitted — whenever the loader could not determine it (missing/unreadable/malformed
  // `package.json`, or a non-string `version` field); never a load-failure mode.
  packageVersion: z.string().nullable(),
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

      // Story 23.2 fix (code review): `policy` is intentionally frozen at boot (AC-4) and
      // `enabled`/`state` must stay exactly what booted — this route never overrides those. But
      // the story's own persona journey (step 2b) requires this diagnostics envelope to be able
      // to show "replacementProven: true, appliedAtBoot: false" the moment a colleague's first
      // successful SSO login writes the latch, WITHOUT waiting for a restart — otherwise
      // AC-17.4's pre-flight checklist ("confirm replacementProven before restarting") has
      // nothing live to read. `getNativeLoginPolicyState()` alone can't do this: it only returns
      // the frozen boot snapshot. So this route — the one place a DB read for this is already
      // allowed (see sessionsLive above) — re-reads the latch live and reports the CURRENT
      // proven state, layered onto (never replacing) the frozen enabled/state.
      // Story 23.2 fix (code review): scoped to the currently-loaded extension — a latch proven
      // by a DIFFERENT (or since-removed) extension must not be reported as proof for whatever
      // is loaded now. See isLatchProvenForExtension()'s doc comment.
      const latch = await readReplacementLatch()
      const replacementProven = isLatchProvenForExtension(
        latch,
        status.status === 'loaded' ? status.manifest.name : null
      )
      // appliedAtBoot is false in exactly one case: the exclusion is now fully declared+proven
      // but the running process hasn't picked it up yet because it hasn't been restarted since
      // (i.e. `state` is not already 'disabled' or 'break_glass'). Every other case — nothing
      // declared, not yet proven, already disabled, or break-glass override — is "applied" as
      // far as this running process is concerned.
      const pendingRestart =
        policy.state !== 'disabled' &&
        policy.state !== 'break_glass' &&
        policy.replacementDeclared &&
        replacementProven

      return {
        extension:
          status.status === 'loaded'
            ? {
                name: status.manifest.name,
                apiVersion: status.manifest.apiVersion,
                capabilities: status.manifest.capabilities,
                loadedAt: status.loadedAt,
                packageVersion: status.packageVersion ?? null,
              }
            : null,
        nativeLoginPolicy: {
          ...policy,
          replacementProven,
          replacementProvenAt: replacementProven
            ? (latch?.replacementProvenAt ?? policy.replacementProvenAt)
            : null,
          appliedAtBoot: !pendingRestart,
          sessionsLive,
        },
      }
    },
  })
}
