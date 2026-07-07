import { getCredential, listCredentialVersions } from '$lib/api/credentials.js'
import { listRotations } from '$lib/api/rotations.js'
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
const ACTIVE_ROTATION_STATUSES = new Set(['in_progress', 'stale_recovery'])

// Shared "nothing loaded" shape for both the 404 (notFound) and 503 (vaultSealed) branches below
// — only the trailing discriminant fields differ between the two callers.
function emptyCredentialPageResult(projectId: string, credentialId: string, orgRole: string) {
  return {
    projectId,
    credentialId,
    orgRole,
    credential: null,
    versions: [],
    rotations: [],
    rotationsPage: 1,
    rotationsHasMore: false,
    activeRotationId: null,
  }
}

// Extracted from `load`'s catch block purely to keep that function's cyclomatic complexity under
// this project's lint threshold — behavior is unchanged: 404 -> notFound, 503 -> vaultSealed
// (AC-1), anything else rethrows.
function handleCredentialLoadError(
  error: unknown,
  projectId: string,
  credentialId: string,
  orgRole: string
) {
  if (!(error instanceof ApiClientError)) throw error
  if (error.status === 404) {
    return {
      ...emptyCredentialPageResult(projectId, credentialId, orgRole),
      notFound: true as const,
    }
  }
  // AC-1: every call in `load`'s Promise.all is vault-guarded (getCredential,
  // listCredentialVersions, listRotations x2) — a sealed vault 503s all four, so a 503 from any
  // single one means none of them could have succeeded (D1).
  if (error.status === 503) {
    return {
      ...emptyCredentialPageResult(projectId, credentialId, orgRole),
      notFound: false as const,
      vaultSealed: true as const,
    }
  }
  throw error
}

export const load: PageServerLoad = async ({ params, fetch, locals, url }) => {
  const orgRole = requireUser(locals).orgRole
  const requestedPage = Number(url.searchParams.get('page') ?? '1')
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1

  try {
    const [credential, versions, mostRecentRotation, rotations] = await Promise.all([
      getCredential(fetch, params.projectId, params.credentialId),
      listCredentialVersions(fetch, params.projectId, params.credentialId),
      listRotations(fetch, params.projectId, params.credentialId, { limit: 1 }),
      listRotations(fetch, params.projectId, params.credentialId, { page, limit: 10 }),
    ])
    const latest = mostRecentRotation.items[0] ?? null
    const activeRotationId =
      latest && ACTIVE_ROTATION_STATUSES.has(latest.status) ? latest.id : null

    return {
      projectId: params.projectId,
      credentialId: params.credentialId,
      orgRole,
      credential,
      versions: versions.items,
      rotations: rotations.items,
      rotationsPage: rotations.page,
      rotationsHasMore: rotations.hasMore,
      activeRotationId,
    }
  } catch (error) {
    return handleCredentialLoadError(error, params.projectId, params.credentialId, orgRole)
  }
}
