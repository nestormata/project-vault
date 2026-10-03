import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import type { MachineUserSummary } from '@project-vault/shared'
import { listApiKeys, listMachineUsers } from '$lib/api/machine-users.js'
import type { OrgRole } from '$lib/machine-users/permissions.js'
import { loadOr404WithOrgRole } from '$lib/server/load-or-404.js'
import type { PageServerLoad } from './$types.js'

type MachineUserListItem = MachineUserSummary & { keyCount: number }

type LoadResult = {
  projectId: string
  orgRole: OrgRole
  machineUsers: { items: MachineUserListItem[]; total: number }
  notFound: boolean
}

// AC-1: the list endpoint (MachineUserSummarySchema) does not itself carry a key count — this
// story does not add a new backend endpoint, so the per-row key count the AC calls
// for is derived here with one `listApiKeys` call per machine user rather than changing the API
// contract. Project-scoped machine-user lists are expected to be small (admin-provisioned CI/CD
// identities, not an end-user-facing high-cardinality list).
const ownLoad = (({ params, fetch, locals }) =>
  loadOr404WithOrgRole<LoadResult>(
    locals,
    async (orgRole) => {
      const machineUsers = await listMachineUsers(fetch, params.projectId)
      const items = await Promise.all(
        machineUsers.items.map(async (item) => {
          const apiKeys = await listApiKeys(fetch, item.id)
          return { ...item, keyCount: apiKeys.total }
        })
      )

      return {
        projectId: params.projectId,
        orgRole,
        machineUsers: { items, total: machineUsers.total },
        notFound: false,
      }
    },
    (orgRole) => ({
      projectId: params.projectId,
      orgRole,
      machineUsers: { items: [], total: 0 },
      notFound: true,
    })
  )) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(
  ownLoad,
  '/(app)/projects/[projectId]/machine-users',
  'page'
)

export const actions = injectActions('/(app)/projects/[projectId]/machine-users')
