import type { ApiKeyMetadata, MachineUserDetail } from '@project-vault/shared'
import { getMachineUser, listApiKeys } from '$lib/api/machine-users.js'
import type { OrgRole } from '$lib/machine-users/permissions.js'
import { loadOr404WithOrgRole } from '$lib/server/load-or-404.js'
import type { PageServerLoad } from './$types.js'

type LoadResult = {
  projectId: string
  machineUserId: string
  orgRole: OrgRole
  machineUser: MachineUserDetail | null
  apiKeys: { items: ApiKeyMetadata[]; total: number }
  notFound: boolean
}

export const load: PageServerLoad = ({ params, fetch, locals }) =>
  loadOr404WithOrgRole<LoadResult>(
    locals,
    async (orgRole) => {
      const [machineUser, apiKeys] = await Promise.all([
        getMachineUser(fetch, params.machineUserId),
        listApiKeys(fetch, params.machineUserId),
      ])

      return {
        projectId: params.projectId,
        machineUserId: params.machineUserId,
        orgRole,
        machineUser,
        apiKeys,
        notFound: false,
      }
    },
    (orgRole) => ({
      projectId: params.projectId,
      machineUserId: params.machineUserId,
      orgRole,
      machineUser: null,
      apiKeys: { items: [], total: 0 },
      notFound: true,
    })
  )
