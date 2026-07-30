import { error } from '@sveltejs/kit'
import {
  getCredential,
  listCredentialDependencies,
  listCredentialVersions,
} from '$lib/api/credentials.js'
import { listRotations } from '$lib/api/rotations.js'
import { listCredentialShares, listRotationRecommendedNudges } from '$lib/api/credential-shares.js'
import { listOrgUsers } from '$lib/api/org-users.js'
import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// AC-2: a credential is treated as having an active rotation whenever its most recent rotation
// (the first item of `GET .../rotations?limit=1`, already ordered most-recent-first per 5.1) is
// in one of these non-terminal-for-UI-purposes statuses.
//
// `break_glass_complete` is intentionally excluded: it is a terminal status (the API never
// transitions it to anything else — confirmed via `apps/api/src/modules/rotation/service.ts`),
// and `previousVersionOverlap` (the only signal that could indicate a still-"live" overlap
// window) is only ever present in the synchronous break-glass POST response — it is never
// included in `GET .../rotations` (list) or `GET .../rotations/:id` (detail) afterwards, and the
// backend's own `409 rotation_in_progress` guard on `POST .../rotations` never fires against a
// `break_glass_complete` rotation either. Treating it as "active" here has no server-side
// backing and previously caused a permanent dead end: a credential that ever underwent a
// break-glass rotation could never have another rotation initiated through this UI again.
// Story 5.6 AC-2.6: widened to match the backend's own widened "active" set — a staged or
// promoted-but-unretired rotation is exactly as blocking of a new rotation as an in_progress one
// was pre-5.6 (the API's partial unique index enforces this server-side regardless; this list
// just keeps the "Rotate" CTA's client-side link-out logic in sync with that reality).
const ACTIVE_ROTATION_STATUSES = new Set(['in_progress', 'staged', 'promoted', 'stale_recovery'])

// Story 18.2 AC-2/AC-5: the share link is built client-side (after the POST response, on a page
// the user is already viewing), so it derives its origin from this load's own request rather than
// the server-only `WEB_BASE_URL` env var — that keeps it correct on custom domains/preview
// environments without needing an env var kept in sync. `url.origin` on a real SvelteKit request
// is always a well-formed http(s) origin; the guard below exists so a broken request context fails
// the load loudly (500) instead of the page ever rendering a "https://undefined/shares/..." link.
function resolveTrustedOrigin(url: URL): string {
  const origin = url.origin
  if (!origin || origin === 'null' || !/^https?:\/\//.test(origin)) {
    throw error(500, 'Unable to resolve a trusted origin for this request')
  }
  return origin
}

// Shared "nothing loaded" shape for both the 404 (notFound) and 503 (vaultSealed) branches below
// — only the trailing discriminant fields differ between the two callers.
function emptyCredentialPageResult(
  projectId: string,
  credentialId: string,
  orgRole: string,
  origin: string
) {
  return {
    projectId,
    credentialId,
    orgRole,
    origin,
    credential: null,
    versions: [],
    dependencies: { items: [], hasDependencies: false, hasStagedRotation: false },
    rotations: [],
    rotationsPage: 1,
    rotationsHasMore: false,
    activeRotationId: null,
    // Story 17.1 AC-11: Shares tab data — empty on any load failure, same as every other section.
    shares: [],
    sharesTotal: 0,
    // Story 17.3 AC-11: rotation-recommended nudge state — empty on any load failure too.
    rotationRecommendedNudges: [],
    orgMembers: [],
  }
}

// Extracted from `load`'s catch block purely to keep that function's cyclomatic complexity under
// this project's lint threshold — behavior is unchanged: 404 -> notFound, 503 -> vaultSealed
// (AC-1), anything else rethrows.
function handleCredentialLoadError(
  loadError: unknown,
  projectId: string,
  credentialId: string,
  orgRole: string,
  origin: string
) {
  if (!(loadError instanceof ApiClientError)) throw loadError
  if (loadError.status === 404) {
    return {
      ...emptyCredentialPageResult(projectId, credentialId, orgRole, origin),
      notFound: true as const,
    }
  }
  // AC-1/AC-D1: every call in `load`'s Promise.all is vault-guarded (getCredential,
  // listCredentialVersions, listCredentialDependencies, listRotations x2) — a sealed vault 503s
  // all five, so a 503 from any single one means none of them could have succeeded (D1).
  if (loadError.status === 503) {
    return {
      ...emptyCredentialPageResult(projectId, credentialId, orgRole, origin),
      notFound: false as const,
      vaultSealed: true as const,
    }
  }
  throw loadError
}

const SHARES_PAGE_SIZE = 25

function parsePositiveIntParam(url: URL, key: string): number {
  const raw = Number(url.searchParams.get(key) ?? '1')
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

// Story 17.3 AC-1/AC-2: Shares tab status filter + pagination, driven by URL query params so
// filter/page state survives a reload/shared link, same convention as the rotations `page` param.
// Extracted purely to keep `load`'s own cyclomatic complexity under this repo's eslint threshold.
function parseSharesQuery(url: URL): { status: string | undefined; page: number } {
  return {
    status: url.searchParams.get('sharesStatus') ?? undefined,
    page: parsePositiveIntParam(url, 'sharesPage'),
  }
}

export const load: PageServerLoad = async ({ params, fetch, locals, url }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole
  const origin = resolveTrustedOrigin(url)
  const page = parsePositiveIntParam(url, 'page')
  const sharesQuery = parseSharesQuery(url)
  const sharesStatus = sharesQuery.status
  const sharesPage = sharesQuery.page

  try {
    const [
      credential,
      versions,
      dependencies,
      mostRecentRotation,
      rotations,
      shares,
      rotationRecommendedNudges,
      orgMembers,
    ] = await Promise.all([
      getCredential(fetch, params.projectId, params.credentialId),
      listCredentialVersions(fetch, params.projectId, params.credentialId),
      listCredentialDependencies(fetch, params.projectId, params.credentialId),
      listRotations(fetch, params.projectId, params.credentialId, { limit: 1 }),
      listRotations(fetch, params.projectId, params.credentialId, { page, limit: 10 }),
      listCredentialShares(fetch, params.projectId, params.credentialId, {
        status: sharesStatus as never,
        limit: SHARES_PAGE_SIZE,
        offset: (sharesPage - 1) * SHARES_PAGE_SIZE,
      }),
      listRotationRecommendedNudges(fetch, params.projectId, params.credentialId),
      listOrgUsers(fetch),
    ])
    const latest = mostRecentRotation.items[0] ?? null
    const activeRotationId =
      latest && ACTIVE_ROTATION_STATUSES.has(latest.status) ? latest.id : null

    return {
      projectId: params.projectId,
      credentialId: params.credentialId,
      orgRole,
      origin,
      credential,
      versions: versions.items,
      dependencies,
      rotations: rotations.items,
      rotationsPage: rotations.page,
      rotationsHasMore: rotations.hasMore,
      activeRotationId,
      shares: shares.items,
      sharesTotal: shares.total,
      sharesPage,
      sharesStatus: sharesStatus ?? null,
      rotationRecommendedNudges: rotationRecommendedNudges.items,
      // Recipient typeahead is scoped to active org members other than the current sharer
      // (self-share is rejected server-side anyway, but excluding it here keeps the picker
      // honest — same for a deactivated member, since AC-2 would reject that too).
      orgMembers: orgMembers.filter(
        (member) => member.userId !== user.userId && member.status === 'active'
      ),
    }
  } catch (loadError) {
    return handleCredentialLoadError(
      loadError,
      params.projectId,
      params.credentialId,
      orgRole,
      origin
    )
  }
}
