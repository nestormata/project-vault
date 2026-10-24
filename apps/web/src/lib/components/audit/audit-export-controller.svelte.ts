import { triggerAuditExport, getAuditExportStatus, type AuditExportStatus } from '$lib/api/audit.js'
import { ApiClientError } from '$lib/api/client.js'
import { toIsoRangeStart, toIsoRangeEnd } from '$lib/audit/date-range.js'

// AC group C — Audit Export trigger/status/download. Polls GET /audit/exports/:jobId every 2s,
// capped at 60 attempts (2 minutes) per AC-C1 (adversarial review, medium: an unbounded poll has
// no stated failure mode, and this cap keeps a single panel within the endpoint's 60/min rate
// limit). A 429 mid-poll backs off (skips the next scheduled attempt) rather than failing
// terminally or hammering the endpoint at the same cadence (adversarial review, low).
const MAX_POLLS = 60
const POLL_INTERVAL_MS = 2000
const BACKOFF_INTERVAL_MS = POLL_INTERVAL_MS * 2

function describeError(err: unknown, fallback: string): string {
  return err instanceof ApiClientError ? (err.message ?? fallback) : fallback
}

/**
 * Story 69.12: the one owner of the export panel's date range, trigger and polling state, created
 * by `AuditExportPanel` and handed to its form, status and result sub-regions.
 */
export class AuditExportController {
  from = $state('')
  to = $state('')
  jobId = $state<string | null>(null)
  status = $state<AuditExportStatus['status'] | null>(null)
  integritySummary = $state<AuditExportStatus['integritySummary']>(null)
  errorMessage = $state<string | null>(null)
  rateLimited = $state(false)
  capped = $state(false)
  triggering = $state(false)
  #pollCount = 0
  #timer: ReturnType<typeof setTimeout> | null = null

  stopPolling(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  // Every scheduled attempt counts toward the cap, a backed-off 429 included: otherwise a sustained
  // rate-limit (e.g. another tab polling the same job) would back off forever without reaching it.
  #scheduleNext(delayMs: number): void {
    this.#pollCount += 1
    if (this.#pollCount >= MAX_POLLS) {
      this.capped = true
      this.stopPolling()
      return
    }
    this.#timer = setTimeout(() => void this.poll(), delayMs)
  }

  async poll(): Promise<void> {
    if (!this.jobId) return
    try {
      const result = await getAuditExportStatus(fetch, this.jobId)
      this.rateLimited = false
      this.status = result.status
      this.integritySummary = result.integritySummary ?? null
      if (result.status === 'completed' || result.status === 'failed') {
        this.stopPolling()
        return
      }
      this.#scheduleNext(POLL_INTERVAL_MS)
    } catch (err) {
      this.#onPollError(err)
    }
  }

  #onPollError(err: unknown): void {
    if (err instanceof ApiClientError && err.status === 429) {
      this.rateLimited = true
      this.#scheduleNext(BACKOFF_INTERVAL_MS)
      return
    }
    this.errorMessage = describeError(err, 'Failed to check export status')
    this.stopPolling()
  }

  #reset(): void {
    this.errorMessage = null
    this.rateLimited = false
    this.capped = false
    this.#pollCount = 0
    this.jobId = null
    this.status = null
    this.integritySummary = null
    this.stopPolling()
  }

  async start(): Promise<void> {
    if (this.triggering || !this.from || !this.to) return
    this.triggering = true
    this.#reset()
    try {
      const result = await triggerAuditExport(fetch, {
        from: toIsoRangeStart(this.from),
        to: toIsoRangeEnd(this.to),
      })
      this.jobId = result.jobId
      this.status = 'pending'
      this.#timer = setTimeout(() => void this.poll(), POLL_INTERVAL_MS)
    } catch (err) {
      this.errorMessage = describeError(err, 'Failed to start export')
    } finally {
      this.triggering = false
    }
  }

  checkAgain(): void {
    this.capped = false
    void this.poll()
  }
}
