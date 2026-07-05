import { getCredential, listCredentialVersions } from '$lib/api/credentials.js'
import { listRotations } from '$lib/api/rotations.js'
import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// AC-2: a credential is treated as having an active rotation whenever its most recent rotation
// (the first item of `GET .../rotations?limit=1`, already ordered most-recent-first per 5.1) is
// in one of these non-terminal-for-UI-purposes statuses.
const ACTIVE_ROTATION_STATUSES = new Set(['in_progress', 'stale_recovery', 'break_glass_complete'])

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
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        projectId: params.projectId,
        credentialId: params.credentialId,
        orgRole,
        credential: null,
        versions: [],
        rotations: [],
        rotationsPage: 1,
        rotationsHasMore: false,
        activeRotationId: null,
        notFound: true as const,
      }
    }
    throw error
  }
}
