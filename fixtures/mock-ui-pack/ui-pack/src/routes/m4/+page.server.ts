import { auditExportDownloadUrl } from '$lib/api/audit.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// M4: this page (outside `(app)`) reads through the replaced `$lib/server/require-user.ts` and the
// replaced `$lib/api/audit.ts`. An anonymous request is redirected by PV's ORIGINAL requireUser,
// which the wrap calls first, so the wrap never weakens it.
export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals)
  return { org: user.orgName, url: auditExportDownloadUrl('job-1') }
}
