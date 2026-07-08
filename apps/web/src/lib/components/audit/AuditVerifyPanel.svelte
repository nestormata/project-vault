<script lang="ts">
  // AC group D — Audit Integrity Verification. Story 8.1's own AC-15/UX-DR13 requirement: the
  // response's `summary` string is the headline result, rendered verbatim (not a raw JSON dump),
  // "designed to be comprehensible to a non-cryptographer."
  import { verifyAuditRange, type AuditVerifyResult } from '$lib/api/audit.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { toIsoRangeStart, toIsoRangeEnd } from '$lib/audit/date-range.js'

  let from = $state('')
  let to = $state('')
  let result = $state<AuditVerifyResult | null>(null)
  let errorMessage = $state<string | null>(null)
  let running = $state(false)

  async function onRunCheck() {
    if (running || !from || !to) return
    running = true
    errorMessage = null
    result = null
    try {
      result = await verifyAuditRange(fetch, toIsoRangeStart(from), toIsoRangeEnd(to))
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429) {
        errorMessage = "You're doing that too quickly — please wait a moment and try again."
      } else if (err instanceof ApiClientError) {
        // AC-D3 — the exact server message is surfaced; date inputs stay populated (no reset)
        // so the user can narrow the range without re-entering both dates.
        errorMessage = err.message ?? 'Integrity check failed'
      } else {
        errorMessage = 'Integrity check failed'
      }
    } finally {
      running = false
    }
  }
</script>

<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Integrity Verification</h2>
  <p class="mt-1 text-sm text-slate-600">
    Verify that audit events in a date range have not been tampered with (range of 90 days or
    fewer).
  </p>

  <div class="mt-4 flex flex-wrap items-end gap-3">
    <label class="flex flex-col text-sm text-slate-700" for="verify-from">
      From
      <input
        id="verify-from"
        type="date"
        class="rounded-lg border border-slate-300 px-2 py-1"
        bind:value={from}
      />
    </label>
    <label class="flex flex-col text-sm text-slate-700" for="verify-to">
      To
      <input
        id="verify-to"
        type="date"
        class="rounded-lg border border-slate-300 px-2 py-1"
        bind:value={to}
      />
    </label>
    <button
      type="button"
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      disabled={running || !from || !to}
      onclick={() => void onRunCheck()}
    >
      {running ? 'Checking…' : 'Run integrity check'}
    </button>
  </div>

  {#if errorMessage}
    <p
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {errorMessage}
    </p>
  {/if}

  {#if result}
    {#if result.rowsChecked === 0}
      <p class="mt-4 text-sm text-slate-600">No audit events in this range to verify.</p>
    {:else}
      <p
        class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"
      >
        {result.summary}
      </p>
    {/if}

    {#if result.failed.length > 0}
      <div class="mt-4 rounded-xl border border-red-300 bg-red-50 p-4">
        <p class="text-sm font-semibold text-red-800">
          {result.failedCount} record{result.failedCount === 1 ? '' : 's'} failed verification:
        </p>
        <ul class="mt-2 space-y-1 text-sm text-red-800">
          {#each result.failed as row (row.id)}
            <li>{row.eventType} — {row.timestamp}</li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
</div>
