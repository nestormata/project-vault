import { listEffectiveProjectAccess } from '../../lib/effective-project-access.js'
import { inManagedOrg } from './role-provisioning.js'

export async function readServiceEffectiveProjectAccess(
  organizationId: string,
  userId: string
): Promise<{
  userId: string
  items: Awaited<ReturnType<typeof listEffectiveProjectAccess>>['items']
  groupGrantEvaluation: Awaited<
    ReturnType<typeof listEffectiveProjectAccess>
  >['groupGrantEvaluation']
}> {
  return inManagedOrg(organizationId, async (tx) => {
    const listed = await listEffectiveProjectAccess(tx, {
      orgId: organizationId,
      subjectUserId: userId,
      visibleProjectIds: 'all-active',
    })
    return { userId, ...listed }
  })
}
