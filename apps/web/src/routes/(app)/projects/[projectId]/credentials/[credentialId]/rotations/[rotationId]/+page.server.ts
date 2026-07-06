import { getRotation } from '$lib/api/rotations.js'
import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
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
    throw error
  }
}
