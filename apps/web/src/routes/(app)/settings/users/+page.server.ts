import { listOrgUsers, type OrgUser } from '$lib/api/org-users.js'
import { requireUser } from '$lib/server/require-user.js'
import { resolveNativeLoginEnabled } from '$lib/server/native-login-status.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole
  const canManage = orgRole === 'owner' || orgRole === 'admin'

  let users: OrgUser[] = []
  if (canManage) {
    try {
      users = await listOrgUsers(fetch)
    } catch {
      users = []
    }
  }

  // Story 23.2 AC-6 row #10 / G3: the "send recovery link" action 403s
  // (native_login_disabled) once native login is excluded — hide/disable it with the honest
  // reason instead of leaving a button that fails on click. Fail-safe default (true) on a
  // failed/null health check, matching every other AC-13 consumer of this helper.
  const nativeLoginEnabled = (await resolveNativeLoginEnabled(fetch)) ?? true

  return { canManage, orgRole, orgId: user.orgId, users, nativeLoginEnabled }
}
