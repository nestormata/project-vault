import { verifyAuditRange, type AuditVerifyResult } from '$lib/api/audit.js'
import { ApiClientError } from '$lib/api/client.js'
import { toIsoRangeStart, toIsoRangeEnd } from '$lib/audit/date-range.js'

const RATE_LIMITED_MESSAGE = "You're doing that too quickly — please wait a moment and try again."
const FAILED_MESSAGE = 'Integrity check failed'

function verifyErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError && err.status === 429) return RATE_LIMITED_MESSAGE
  // AC-D3 — the exact server message is surfaced; date inputs stay populated (no reset) so the
  // user can narrow the range without re-entering both dates.
  if (err instanceof ApiClientError) return err.message ?? FAILED_MESSAGE
  return FAILED_MESSAGE
}

/**
 * Story 69.12: the one owner of the verify panel's date range, running flag, error and result,
 * created by `AuditVerifyPanel` and handed to its form, error and result sub-regions.
 */
export class AuditVerifyController {
  from = $state('')
  to = $state('')
  result = $state<AuditVerifyResult | null>(null)
  errorMessage = $state<string | null>(null)
  running = $state(false)

  async run(): Promise<void> {
    if (this.running || !this.from || !this.to) return
    this.running = true
    this.errorMessage = null
    this.result = null
    try {
      this.result = await verifyAuditRange(
        fetch,
        toIsoRangeStart(this.from),
        toIsoRangeEnd(this.to)
      )
    } catch (err) {
      this.errorMessage = verifyErrorMessage(err)
    } finally {
      this.running = false
    }
  }
}
