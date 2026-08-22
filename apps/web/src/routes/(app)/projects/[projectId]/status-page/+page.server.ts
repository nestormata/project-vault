import { error } from '@sveltejs/kit'
import { assertTrustedOrigin, CapabilityId, type StatusPageConfig } from '@project-vault/shared'
import { listProjectMembers } from '$lib/api/org-users.js'
import { listServiceEndpoints, type ServiceEndpoint } from '$lib/api/service-endpoints.js'
import { getStatusPageConfig } from '$lib/api/status-page.js'
import { getCapabilityMap, type CapabilityMap } from '$lib/api/capabilities.js'
import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 23.7 AC-9: cosmetic gating fails open by design — Story 23.3's backend gate is the sole
// enforcement point and denies the actual mutating request regardless of what this page shows.
// Failing this fetch closed would hide a working feature during an unrelated capability-service
// outage, which is a worse failure mode than briefly showing a control whose backend call will
// still be correctly enforced. Every id defaults to permitted:true — a literal, typed default
// keyed the same as CapabilityId, not a magic "all true" shortcut that would silently stop
// compiling if CapabilityId gains a member.
const DEFAULT_CAPABILITIES: CapabilityMap = {
  [CapabilityId.MONITORING_PUBLIC_STATUS_PAGE]: true,
}

/** AC-9 edge case: a 200 whose body fails schema validation (missing key, non-boolean value) is
 * treated identically to a network failure — fail open, never partially trust a malformed
 * payload. */
function isValidCapabilityMap(value: unknown): value is CapabilityMap {
  if (!value || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'boolean')
}

// AC-9 edge case: a 401 mid-load on THIS specific fetch already has its own, existing handling —
// apiFetch's 401-with-refresh-retry machinery (client.ts), the same one every other authenticated
// SSR fetch on this page (including getStatusPageConfig/listServiceEndpoints, which have no
// fail-open catch at all) already defers to. This story adds no new session-handling logic: a
// session-refresh-eligible 401 is re-thrown here so it propagates exactly as it would from any of
// the load function's other calls, instead of being silently absorbed into the fail-open default.
function isSessionRefreshEligible(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status === 401 &&
    (error.code === 'access_token_missing' ||
      error.code === 'access_token_invalid' ||
      error.code === 'session_revoked')
  )
}

async function loadCapabilityMap(fetchFn: typeof fetch): Promise<CapabilityMap> {
  try {
    const result = await getCapabilityMap(fetchFn)
    return isValidCapabilityMap(result.capabilities) ? result.capabilities : DEFAULT_CAPABILITIES
  } catch (err) {
    if (isSessionRefreshEligible(err)) throw err
    return DEFAULT_CAPABILITIES
  }
}

// Story 18.2 AC-5: mirrors the credential-detail load's guard so this route fails loudly (500) at
// load/SSR time on a broken request context instead of only surfacing the problem later, inside
// the `$derived` in +page.svelte, when the user clicks Enable/Regenerate.
function resolveTrustedOrigin(url: URL): string {
  try {
    return assertTrustedOrigin(url.origin)
  } catch {
    throw error(500, 'Unable to resolve a trusted origin for this request')
  }
}

// Story 6.3 ADR-6.3-07 (Task 9): gate the section in the UI on the SAME project-owner-or-org-owner
// condition as the backend — not project-owner alone. An org owner who isn't a project member
// still passes every backend authorization check, so the UI must check both axes too, or they
// would be unable to find this section. Server-side enforcement remains authoritative regardless.
export const load: PageServerLoad = async ({ params, fetch, locals, url }) => {
  const user = requireUser(locals)
  const isOrgOwner = user.orgRole === 'owner'

  let members: Awaited<ReturnType<typeof listProjectMembers>> = []
  try {
    members = await listProjectMembers(fetch, params.projectId)
  } catch {
    members = []
  }
  const selfMember = members.find((m) => m.userId === user.userId)
  const isProjectOwner = selfMember?.role === 'owner'
  const canManage = isProjectOwner || isOrgOwner

  let config: StatusPageConfig = { enabled: false }
  let serviceEndpoints: ServiceEndpoint[] = []
  let capabilities: CapabilityMap = DEFAULT_CAPABILITIES
  if (canManage) {
    // Story 23.7 AC-7: SSR fetch decision, made explicitly. A flash of an enabled "Enable public
    // status page" button that becomes disabled 100-300ms later, on a control whose failure mode
    // is only cosmetic to begin with, is worse UX than SSR's small internal latency cost —
    // especially since the backend gate (Story 23.3) is the real enforcement and a user who
    // manages to click during the flash still gets a clean 403, not a broken state. SSR also lets
    // this story reuse the existing canManage-gated Promise.all fetch shape instead of
    // introducing this codebase's first client-side capability-aware loading state.
    //
    // AC-9 / Task 5: the fail-open `.catch()` is attached to the capability-map promise
    // INDIVIDUALLY, as one array element — not a try/catch around the whole Promise.all. Wrapping
    // the entire Promise.all would silently swallow a genuine failure of
    // getStatusPageConfig/listServiceEndpoints too; those two calls have no fail-open behavior
    // today and are not supposed to gain one as a side effect of this story.
    ;[config, serviceEndpoints, capabilities] = await Promise.all([
      getStatusPageConfig(fetch, params.projectId),
      listServiceEndpoints(fetch, params.projectId),
      loadCapabilityMap(fetch),
    ])
  }

  return {
    projectId: params.projectId,
    // Story 18.2 AC-4: the public status-page link previously derived its origin ad hoc from
    // `window.location.origin` client-side (breaking under SSR/no-JS and duplicating the
    // credential-share link's own origin-resolution logic). Centralized on the same
    // request-origin convention as the credential detail page.
    origin: resolveTrustedOrigin(url),
    canManage,
    config,
    serviceEndpoints,
    capabilities,
  }
}
