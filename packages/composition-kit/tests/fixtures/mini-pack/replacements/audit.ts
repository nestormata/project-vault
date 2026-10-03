// Story 68.5 AC-12: a `$lib/api` module replacement that wraps PV's original module. Everything PV
// exports is kept; one function is wrapped, and its callers receive the wrapper.
import { auditExportDownloadUrl as original } from 'pv-original:$lib/api/audit.ts'

export * from 'pv-original:$lib/api/audit.ts'

export function auditExportDownloadUrl(jobId: string): string {
  return `${original(jobId)}?via=acme`
}
