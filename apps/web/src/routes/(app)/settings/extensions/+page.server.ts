import { ApiClientError } from '$lib/api/client.js'
import { getExtensionStatus, type ExtensionStatus } from '$lib/api/extensions.js'
import { fetchHealth, type HealthResponse } from '$lib/api/platform.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 14.5 AC-5 / Dev Notes RBAC judgment call: mirrors Story 14.2's API-side
// `allowedRoles: ['admin']` exactly — 'owner' is deliberately NOT admin-equivalent here.
const EXTENSIONS_PAGE_ROLE = 'admin'

const GENERIC_FETCH_ERROR = 'Failed to load extension status, try again.'

export type ExtensionsHealthStatus = 'not_configured' | 'loaded' | 'load_failed'

export type ExtensionsPageData =
  | { allowed: false; orgRole: string }
  | {
      allowed: true
      orgRole: string
      mfaRequired: boolean
      manifest: ExtensionStatus | null
      healthStatus: ExtensionsHealthStatus | null
      errorMessage: string | null
    }

type AllowedPageData = Extract<ExtensionsPageData, { allowed: true }>

function isMfaRequiredError(reason: unknown): boolean {
  return reason instanceof ApiClientError && reason.status === 403 && reason.code === 'mfa_required'
}

// AC-8: mismatches between the manifest and /health's extensions_status are a developer-facing
// boot-timing-race signal, not an admin-facing problem — no new backend audit event, just a
// console note for whoever notices it in server logs.
// eslint-disable-next-line no-console -- intentional developer diagnostic, not app logging (AC-8)
const logMismatch = (message: string): void => console.warn(`[settings/extensions] ${message}`)

function allowedResult(overrides: Partial<AllowedPageData>, orgRole: string): AllowedPageData {
  return {
    allowed: true,
    orgRole,
    mfaRequired: false,
    manifest: null,
    healthStatus: null,
    errorMessage: null,
    ...overrides,
  }
}

/** Resolves the AC-3/AC-4 not-configured/load-failed distinction once the manifest is null. */
function resolveUnloadedState(orgRole: string, health: HealthResponse | null): AllowedPageData {
  // manifest is null — /health's extensions_status disambiguates "not configured" (the common,
  // honest default) from "load failed" (AC-3 vs AC-4). Without it we cannot tell which honest
  // placeholder to show, so a failed/missing health result is itself a fetch failure here.
  if (!health?.extensions_status) {
    return allowedResult({ errorMessage: GENERIC_FETCH_ERROR }, orgRole)
  }

  if (health.extensions_status === 'loaded') {
    // AC-8 reverse mismatch: /health says loaded but the manifest endpoint returned null. There
    // is no manifest data to render a loaded state with, so fall back to the safest honest
    // placeholder and log the inconsistency for a developer to notice.
    logMismatch('mismatch: /health reports "loaded" but the manifest endpoint returned null')
    return allowedResult({ healthStatus: 'not_configured' }, orgRole)
  }

  return allowedResult({ healthStatus: health.extensions_status }, orgRole)
}

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole

  // AC-5: non-admin roles (including 'owner') never trigger the org-admin-only manifest fetch —
  // avoids a guaranteed, wasted 403 round-trip. GET /health is still fetched here (it's public,
  // unauthenticated, and safe to call for every role per AC-5) but its result is never rendered
  // to a non-admin — a deliberate least-privilege choice, not merely an optimization.
  if (orgRole !== EXTENSIONS_PAGE_ROLE) {
    void fetchHealth(fetch)
    return { allowed: false as const, orgRole }
  }

  // AC-7: two independent network calls with no shared failure mode — Promise.allSettled so one
  // failing never short-circuits the other.
  const [statusResult, healthResult] = await Promise.allSettled([
    getExtensionStatus(fetch),
    fetchHealth(fetch),
  ])

  // AC-7 edge: an admin who hasn't enrolled in MFA gets a 403 mfa_required from the manifest
  // endpoint (requireMfa: true, Story 14.2) — this is not a generic fetch failure, retrying
  // won't help, so it gets its own distinct state rather than the generic errorMessage below.
  if (statusResult.status === 'rejected') {
    if (isMfaRequiredError(statusResult.reason)) {
      return allowedResult({ mfaRequired: true }, orgRole)
    }
    return allowedResult({ errorMessage: GENERIC_FETCH_ERROR }, orgRole)
  }

  // AC-12: the route now returns an envelope ({ extension, nativeLoginPolicy }) rather than a
  // bare manifest-or-null body — this page only consumes `.extension`; `.nativeLoginPolicy` is
  // not yet surfaced here (no story task asked for an admin-facing policy panel on this page).
  const manifest = statusResult.value.extension
  const health = healthResult.status === 'fulfilled' ? healthResult.value : null

  if (manifest) {
    // AC-8: a non-null manifest is authoritative — always render the loaded state regardless of
    // what /health says (health may disagree during a boot-timing race in a rolling deploy).
    if (health && health.extensions_status !== 'loaded') {
      logMismatch(`mismatch: manifest present but /health reports "${health.extensions_status}"`)
    }
    return allowedResult({ manifest, healthStatus: 'loaded' }, orgRole)
  }

  return resolveUnloadedState(orgRole, health)
}
