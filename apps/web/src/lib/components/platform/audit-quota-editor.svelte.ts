import { ApiClientError } from '$lib/api/client.js'
import { setOrgAuditQuota, type AuditStorageOrgRow } from '$lib/api/platform.js'
import {
  defaultByteInputUnit,
  parseByteInput,
  type ByteInputUnit,
} from '$lib/utils/format-bytes.js'

export type OvercommitPending = {
  allocatedLogicalBytes: number
  estimatedPhysicalBytes: number
  instanceLimitBytes: number
  requestedBytes: number
}

type QuotaInput = { quotaBytes: number | null; writeRatePerMinute: number | null }
type SubmitOptions = { acknowledgeOvercommit?: boolean; skipBelowUsageCheck?: boolean }

function isUnsafe(value: number | null): boolean {
  return value !== null && !Number.isSafeInteger(value)
}

function overcommitFrom(body: unknown, quotaBytes: number | null): OvercommitPending {
  const fields = body as Partial<OvercommitPending> | null
  return {
    allocatedLogicalBytes: fields?.allocatedLogicalBytes ?? 0,
    estimatedPhysicalBytes: fields?.estimatedPhysicalBytes ?? 0,
    instanceLimitBytes: fields?.instanceLimitBytes ?? 0,
    requestedBytes: fields?.requestedBytes ?? quotaBytes ?? 0,
  }
}

/** The per-organization audit-storage rows and the one inline quota edit in flight (Story 22.3
 * AC-5). The content component creates it and passes it to the sections that read the rows, render
 * a row or drive the edit form. */
export class AuditQuotaEditor {
  // Story 68.1 AC-3: writable $derived, so a new load resets the rows while a successful quota
  // save can still replace its row in place (mapping over the current, possibly refreshed, rows).
  rows: AuditStorageOrgRow[]
  editingOrgId = $state<string | null>(null)
  quotaValue = $state('')
  quotaUnit = $state<ByteInputUnit>('GB')
  rateValue = $state('')
  saving = $state(false)
  saveError = $state<string | null>(null)
  saveMfaError = $state<string | null>(null)
  saveSuccessOrgId = $state<string | null>(null)
  belowUsagePending = $state(false)
  overcommitPending = $state<OvercommitPending | null>(null)

  constructor(loaded: () => AuditStorageOrgRow[]) {
    this.rows = $derived(loaded())
  }

  startEdit(row: AuditStorageOrgRow): void {
    this.editingOrgId = row.orgId
    this.quotaUnit = defaultByteInputUnit(row.quotaBytes)
    const unitBytes = this.quotaUnit === 'GB' ? 1024 ** 3 : 1024 ** 2
    this.quotaValue = row.quotaBytes === null ? '' : String(row.quotaBytes / unitBytes)
    this.rateValue = row.writeRatePerMinute === null ? '' : String(row.writeRatePerMinute)
    this.saveError = null
    this.saveMfaError = null
    this.belowUsagePending = false
    this.overcommitPending = null
  }

  cancelEdit(): void {
    this.editingOrgId = null
    this.belowUsagePending = false
    this.overcommitPending = null
  }

  #readInput(): QuotaInput {
    // Svelte's `bind:value` on a `type="number"` input coerces the bound value to a JS number
    // once numeric text is entered (not a string) — normalize with String() before trimming so
    // this handles both the empty-string initial state and a post-input numeric value.
    const trimmedQuota = String(this.quotaValue ?? '').trim()
    const trimmedRate = String(this.rateValue ?? '').trim()
    return {
      quotaBytes: trimmedQuota === '' ? null : parseByteInput(Number(trimmedQuota), this.quotaUnit),
      writeRatePerMinute: trimmedRate === '' ? null : Number(trimmedRate),
    }
  }

  async submit(row: AuditStorageOrgRow, opts: SubmitOptions = {}): Promise<void> {
    const input = this.#readInput()
    // Code-review finding: `Number()` on a malformed/overflow input (e.g. "1e400") yields
    // `Infinity`/`NaN`, neither of which is caught by the below-usage check below (both
    // comparisons are vacuously false), and `JSON.stringify(Infinity | NaN)` silently serializes
    // to `null` on the wire — indistinguishable from an intentional "clear to unlimited" request,
    // which would bypass AC-4's overcommit check entirely. Reject non-finite/unsafe values here,
    // before any request is built, rather than let them silently round-trip to "unlimited".
    if (isUnsafe(input.quotaBytes) || isUnsafe(input.writeRatePerMinute)) {
      this.saveError = 'Enter a valid, finite number.'
      return
    }

    // Second-order-thinking review finding: a fat-fingered low quota immediately
    // blocks the org's audit writes — confirm before submitting, client-side only (the API itself
    // must still accept the request unconditionally per AC-3's own required test).
    if (
      !opts.skipBelowUsageCheck &&
      input.quotaBytes !== null &&
      input.quotaBytes < row.bytesUsed
    ) {
      this.belowUsagePending = true
      return
    }
    await this.#save(row, input, opts)
  }

  async #save(row: AuditStorageOrgRow, input: QuotaInput, opts: SubmitOptions): Promise<void> {
    this.saving = true
    this.saveError = null
    this.saveMfaError = null
    this.saveSuccessOrgId = null
    try {
      const updated = await setOrgAuditQuota(fetch, row.orgId, {
        ...input,
        ...(opts.acknowledgeOvercommit ? { acknowledgeOvercommit: true as const } : {}),
      })
      this.rows = this.rows.map((r) => (r.orgId === row.orgId ? updated : r))
      this.editingOrgId = null
      this.belowUsagePending = false
      this.overcommitPending = null
      this.saveSuccessOrgId = row.orgId
    } catch (err) {
      this.#recordFailure(err, input.quotaBytes)
    } finally {
      this.saving = false
    }
  }

  #recordFailure(err: unknown, quotaBytes: number | null): void {
    if (!(err instanceof ApiClientError)) {
      this.saveError = 'Failed to update quota'
    } else if (err.status === 403 && err.code === 'mfa_required') {
      this.saveMfaError = err.message ?? 'MFA required'
    } else if (err.status === 422 && err.code === 'quota_overcommit') {
      this.overcommitPending = overcommitFrom(err.body, quotaBytes)
    } else if (err.status === 404) {
      this.saveError = err.message ?? 'Organization not found — it may have just been deleted.'
    } else {
      this.saveError = err.message ?? 'Failed to update quota'
    }
  }
}
