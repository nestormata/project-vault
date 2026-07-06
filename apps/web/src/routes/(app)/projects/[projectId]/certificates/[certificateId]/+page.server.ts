import { ApiClientError } from '$lib/api/client.js'
import { getCertificate } from '$lib/api/certificates.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const certificate = await getCertificate(fetch, params.projectId, params.certificateId)
    return { projectId: params.projectId, orgRole, certificate, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { projectId: params.projectId, orgRole, certificate: null, notFound: true as const }
    }
    throw error
  }
}
