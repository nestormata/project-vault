<script lang="ts">
  // AC group C — Audit Export trigger/status/download. Polls GET /audit/exports/:jobId every 2s,
  // capped at 60 attempts (2 minutes) per AC-C1 (adversarial review, medium: an unbounded poll has
  // no stated failure mode, and this cap keeps a single panel within the endpoint's 60/min rate
  // limit). A 429 mid-poll backs off (skips the next scheduled attempt) rather than failing
  // terminally or hammering the endpoint at the same cadence (adversarial review, low).
  import {
    triggerAuditExport,
    getAuditExportStatus,
    auditExportDownloadUrl,
    type AuditExportStatus,
  } from '$lib/api/audit.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { toIsoRangeStart, toIsoRangeEnd } from '$lib/audit/date-range.js'

  const MAX_POLLS = 60
  const POLL_INTERVAL_MS = 2000
  const BACKOFF_INTERVAL_MS = POLL_INTERVAL_MS * 2

  let from = $state('')
  let to = $state('')
  let jobId = $state<string | null>(null)
  let status = $state<AuditExportStatus['status'] | null>(null)
  let integritySummary = $state<AuditExportStatus['integritySummary']>(null)
  let errorMessage = $state<string | null>(null)
  let rateLimited = $state(false)
  let capped = $state(false)
  let triggering = $state(false)
  let pollCount = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function stopPolling() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function poll() {
    if (!jobId) return
    try {
      const result = await getAuditExportStatus(fetch, jobId)
      rateLimited = false
      status = result.status
      integritySummary = result.integritySummary ?? null
      if (result.status === 'completed' || result.status === 'failed') {
        stopPolling()
        return
      }
      pollCount += 1
      if (pollCount >= MAX_POLLS) {
        capped = true
        stopPolling()
        return
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429) {
        rateLimited = true
        // A 429 still counts toward the cap — otherwise a sustained rate-limit (e.g. another tab
        // polling the same job) would back off forever without ever reaching MAX_POLLS, since
        // this branch previously returned before the counter below ran.
        pollCount += 1
        if (pollCount >= MAX_POLLS) {
          capped = true
          stopPolling()
          return
        }
        timer = setTimeout(() => void poll(), BACKOFF_INTERVAL_MS)
        return
      }
      errorMessage =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to check export status')
          : 'Failed to check export status'
      stopPolling()
    }
  }

  async function onExport() {
    if (triggering || !from || !to) return
    triggering = true
    errorMessage = null
    rateLimited = false
    capped = false
    pollCount = 0
    jobId = null
    status = null
    integritySummary = null
    stopPolling()
    try {
      const result = await triggerAuditExport(fetch, {
        from: toIsoRangeStart(from),
        to: toIsoRangeEnd(to),
      })
      jobId = result.jobId
      status = 'pending'
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    } catch (err) {
      errorMessage =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to start export')
          : 'Failed to start export'
    } finally {
      triggering = false
    }
  }

  function onCheckAgain() {
    capped = false
    void poll()
  }
</script>

<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Export</h2>
  <p class="mt-1 text-sm text-slate-600">
    Export audit events as CSV. A mandatory integrity check runs first.
  </p>

  <div class="mt-4 flex flex-wrap items-end gap-3">
    <label class="flex flex-col text-sm text-slate-700" for="export-from">
      From
      <input
        id="export-from"
        type="date"
        class="rounded-lg border border-slate-300 px-2 py-1"
        bind:value={from}
      />
    </label>
    <label class="flex flex-col text-sm text-slate-700" for="export-to">
      To
      <input
        id="export-to"
        type="date"
        class="rounded-lg border border-slate-300 px-2 py-1"
        bind:value={to}
      />
    </label>
    <button
      type="button"
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      disabled={triggering || !from || !to}
      onclick={() => void onExport()}
    >
      Export CSV
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

  {#if jobId && (status === 'pending' || status === 'processing') && !capped}
    <p class="mt-4 text-sm text-slate-600">Verifying integrity, then generating export…</p>
  {/if}

  {#if rateLimited}
    <p class="mt-4 text-sm text-amber-800">
      Checking export status is temporarily rate-limited — retrying shortly.
    </p>
  {/if}

  {#if capped}
    <p class="mt-4 text-sm text-amber-800">This export is taking longer than expected.</p>
    <button
      type="button"
      class="mt-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
      onclick={onCheckAgain}
    >
      Check again
    </button>
  {/if}

  {#if status === 'completed' && jobId}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- D3: plain <a href> to a non-page API download endpoint, not a SvelteKit route resolve() can type-check. (`-next-line` doesn't reach the `href` line on a multi-line tag, so this needs the block form.) -->
    <a
      href={auditExportDownloadUrl(jobId)}
      class="mt-4 inline-block rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800"
    >
      Download CSV
    </a>
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {/if}

  {#if status === 'failed'}
    <p class="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      Export failed: integrity verification detected {integritySummary?.failedCount ?? 0} tampered record(s).
      See the Integrity Verification panel below for details.
    </p>
  {/if}
</div>
