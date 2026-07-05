import { redirect } from '@sveltejs/kit'
import { listCredentialDependencies } from '$lib/api/credentials.js'
import { listRotations } from '$lib/api/rotations.js'
import { canManageRotations } from '$lib/components/rotations/rotation-permissions.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Mirrors the credential detail page's active-rotation detection (AC-2) — used here as a
// no-dead-end guard so a direct URL visit to /rotate never lands on a form that would just 409.
const ACTIVE_ROTATION_STATUSES = new Set(['in_progress', 'stale_recovery', 'break_glass_complete'])

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  // AC-6: a member/viewer never triggers any fetch here — the page renders AccessNotice only,
  // and the server never issues the POST on their behalf.
  if (!canManageRotations(orgRole)) {
    return {
      projectId: params.projectId,
      credentialId: params.credentialId,
      orgRole,
      canManage: false as const,
      dependencies: null,
    }
  }

  const history = await listRotations(fetch, params.projectId, params.credentialId, { limit: 1 })
  const latest = history.items[0]
  if (latest && ACTIVE_ROTATION_STATUSES.has(latest.status)) {
    throw redirect(
      303,
      `/projects/${params.projectId}/credentials/${params.credentialId}/rotations/${latest.id}`
    )
  }

  const dependencies = await listCredentialDependencies(
    fetch,
    params.projectId,
    params.credentialId
  )

  return {
    projectId: params.projectId,
    credentialId: params.credentialId,
    orgRole,
    canManage: true as const,
    dependencies,
  }
}
