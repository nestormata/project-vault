import { ApiClientError } from '$lib/api/client.js'
import { runAccessReport, type AccessReportResult } from '$lib/api/audit.js'
import { toIsoRangeStart } from '$lib/audit/date-range.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const ACCESS_REPORT_ROLE = 'owner'

function friendlyAsOfError(message: string): string {
  if (/future/i.test(message)) return 'Access reports cannot be generated for a future date.'
  if (/predates/i.test(message)) return 'This date is before your organization was created.'
  return message
}

// The `asOf` query param comes from either (a) the on-page `<input type="date">` form, which
// submits a bare "YYYY-MM-DD" value the API's `z.iso.datetime()` schema rejects with a 422 (the
// API's own test suite asserts this — "AC-5: rejects a bare date without time"), or (b) this
// page's own pagination links, which already carry a full ISO datetime round-tripped from a
// previous load. Only convert the bare-date case; passing an already-ISO value back through
// `toIsoRangeStart` would double-append a time component and produce an invalid string.
function normalizeAsOf(raw: string | null): string | undefined {
  if (!raw) return undefined
  return raw.includes('T') ? raw : toIsoRangeStart(raw)
}

export const load: PageServerLoad = async ({ fetch, url, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole

  if (orgRole !== ACCESS_REPORT_ROLE) {
    return { orgRole, allowed: false as const }
  }

  // D2 item 1 — the fast/historical branch is determined only by whether `asOf` is present at
  // all; an empty/missing query param means the fast "current state" path.
  const asOf = normalizeAsOf(url.searchParams.get('asOf'))
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
