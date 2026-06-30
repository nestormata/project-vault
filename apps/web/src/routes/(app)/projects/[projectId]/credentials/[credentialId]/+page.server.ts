import { getCredential, listCredentialVersions } from '$lib/api/credentials.js'
import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole
  try {
    const [credential, versions] = await Promise.all([
      getCredential(fetch, params.projectId, params.credentialId),
      listCredentialVersions(fetch, params.projectId, params.credentialId),
    ])
    return {
      projectId: params.projectId,
      credentialId: params.credentialId,
      orgRole,
      credential,
      versions: versions.items,
    }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return {
        projectId: params.projectId,
        credentialId: params.credentialId,
        orgRole,
        credential: null,
        versions: [],
        notFound: true as const,
      }
    }
    throw error
  }
}
