import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const FORWARDING_MANAGE_ROLES = new Set(['owner', 'admin'])

// D2 — no GET readback exists for forwarding/retention config, so this load never calls the API;
// it only resolves the role gate and hands the org id down for the write-only forms below.
export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole

  if (!FORWARDING_MANAGE_ROLES.has(orgRole)) {
    return { orgRole, allowed: false as const }
  }

  return { orgRole, allowed: true as const, orgId: user.orgId }
}
