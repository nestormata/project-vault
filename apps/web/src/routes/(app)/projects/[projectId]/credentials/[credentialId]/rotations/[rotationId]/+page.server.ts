import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { getRotation } from '$lib/api/rotations.js'
import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const rotation = await getRotation(
      fetch,
      params.projectId,
      params.credentialId,
      params.rotationId
    )
    return {
      projectId: params.projectId,
      credentialId: params.credentialId,
      rotationId: params.rotationId,
      orgRole,
      rotation,
      notFound: false as const,
    }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        projectId: params.projectId,
        credentialId: params.credentialId,
        rotationId: params.rotationId,
        orgRole,
        rotation: null,
        notFound: true as const,
      }
    }
    // AC-3: getRotation is vault-guarded — a sealed vault 503s it. A sibling branch, not a
    // replacement of the existing 404 branch above (kept in that order: 404 first as the existing
    // behavior, 503 second as the net-new addition).
    if (error instanceof ApiClientError && error.status === 503) {
      return {
        projectId: params.projectId,
        credentialId: params.credentialId,
        rotationId: params.rotationId,
        orgRole,
        rotation: null,
        notFound: false as const,
        vaultSealed: true as const,
      }
    }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]',
  'page'
)

export const actions = injectActions(
  '/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]'
)
