import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { listCertificates } from '$lib/api/certificates.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ownLoad = (async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  try {
    const certificates = await listCertificates(fetch, params.projectId)
    return { projectId: params.projectId, orgRole, certificates, notFound: false as const }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { projectId: params.projectId, orgRole, certificates: [], notFound: true as const }
    }
    throw error
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/certificates',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/certificates')
