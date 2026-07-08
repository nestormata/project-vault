import { ApiClientError } from '$lib/api/client.js'
import { runAccessReport, type AccessReportResult } from '$lib/api/audit.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ACCESS_REPORT_ROLE = 'owner'

function friendlyAsOfError(message: string): string {
  if (/future/i.test(message)) return 'Access reports cannot be generated for a future date.'
  if (/predates/i.test(message)) return 'This date is before your organization was created.'
  return message
}

export const load: PageServerLoad = async ({ fetch, url, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole

  if (orgRole !== ACCESS_REPORT_ROLE) {
    return { orgRole, allowed: false as const }
  }

  // D2 item 1 — the fast/historical branch is determined only by whether `asOf` is present at
  // all; an empty/missing query param means the fast "current state" path.
  const asOf = url.searchParams.get('asOf') || undefined
  const page = Number(url.searchParams.get('page') ?? '1') || 1

  try {
    const report: AccessReportResult = await runAccessReport(fetch, { asOf, page, limit: 20 })
    return {
      orgRole,
      allowed: true as const,
      asOf,
      page,
      report,
      errorMessage: null as string | null,
    }
  } catch (err) {
    const message =
      err instanceof ApiClientError
        ? friendlyAsOfError(err.message ?? 'Failed to generate access report')
        : 'Failed to generate access report'
    return { orgRole, allowed: true as const, asOf, page, report: null, errorMessage: message }
  }
}
