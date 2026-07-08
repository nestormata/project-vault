<script lang="ts">
  import { resolve } from '$app/paths'
  import { invalidateAll } from '$app/navigation'
  import { executeErasure } from '$lib/api/compliance.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { triggerJsonDownload } from '$lib/download.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import TypedConfirmInput from '$lib/components/forms/TypedConfirmInput.svelte'

  let { data } = $props()

  // D5 — the typed-email confirmation is UI-only friction gating a submit control; the actual
  // request body executeErasure() sends is always exactly { confirm: true }.
  let typedMatches = $state(false)
  let executing = $state(false)
  let executeError = $state<string | null>(null)
  // AC-L4 — distinguished so the banner text is accurate for each outcome: a concurrent execute
  // race ("already being processed") reads differently from a stale double-submit against a
  // request that has, in fact, already finished ("already completed"). Both still route to the
  // same safe "Refresh" control, never a re-racing retry button.
  let alreadyProcessing = $state<'in_progress' | 'completed' | null>(null)

  async function onExecute() {
    if (!typedMatches || executing) return
    executing = true
    executeError = null
    alreadyProcessing = null
    try {
      await executeErasure(fetch, data.userId, data.requestId)
      // AC-L1 — transition directly to the compliance-report view: re-run load() so the page
      // picks up the now-`completed` state (and its full report) from the server.
      await invalidateAll()
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'erasure_already_in_progress') {
        alreadyProcessing = 'in_progress'
      } else if (err instanceof ApiClientError && err.code === 'already_completed') {
        alreadyProcessing = 'completed'
      } else if (err instanceof ApiClientError) {
        // AC-L3/L5 — the exact server message/remediation is surfaced verbatim; the page stays on
        // the pending-review screen (no mutation occurred), so a retry after resolving the
        // blocker out-of-band works without re-creating the request.
        const body = err.body as { remediation?: string; otherOrgCount?: number } | null
        executeError = body?.remediation
          ? `This user belongs to ${body.otherOrgCount} other organization${body.otherOrgCount === 1 ? '' : 's'}. ${body.remediation}`
          : (err.message ?? 'Failed to execute erasure')
      } else {
        executeError = 'Failed to execute erasure'
      }
    } finally {
      executing = false
    }
  }

  function onDownloadReport() {
    if (data.state !== 'completed') return
    triggerJsonDownload(`erasure-report-${data.requestId}.json`, data.report)
  }
</script>

<svelte:head>
  <title>Erasure Request | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Erasure Request</h1>
  <a href={resolve('/settings/users')} class="mt-2 inline-block text-sm text-indigo-600 underline">
    ← Back to Users
  </a>

  {#if data.state === 'not_allowed'}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This page requires the admin role or above.</p>
    </div>
  {:else if data.state === 'not_found'}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This erasure request could not be found.</p>
    </div>
  {:else if data.state === 'in_progress'}
    <div class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6">
      <p class="text-amber-800">This erasure is currently being processed.</p>
      <button
        type="button"
        class="mt-3 rounded-xl border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-800"
        onclick={() => void invalidateAll()}
      >
        Refresh
      </button>
    </div>
  {:else if data.state === 'pending'}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">PII Inventory</h2>
      <p class="mt-1 text-sm text-slate-600">
        This is the scope of what will be removed or retained — nothing has been touched yet.
      </p>

      {#if data.piiInventory}
        <div class="mt-4 overflow-hidden rounded-xl border border-slate-200">
          <table class="min-w-full text-left text-sm">
            <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th class="px-4 py-2 font-semibold">Table</th>
                <th class="px-4 py-2 font-semibold">Rows</th>
                <th class="px-4 py-2 font-semibold">PII fields</th>
              </tr>
            </thead>
            <tbody>
              {#each data.piiInventory.tables as row (row.table)}
                <tr class="border-b border-slate-100 last:border-b-0">
                  <td class="px-4 py-2 font-medium text-slate-900">{row.table}</td>
                  <td class="px-4 py-2 text-slate-600">{row.rowCount}</td>
                  <td class="px-4 py-2 text-slate-600">{row.piiFields.join(', ')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if data.orgRole === 'owner'}
        <div class="mt-6 rounded-xl border border-red-200 bg-red-50 p-4">
          <p class="text-sm font-semibold text-red-800">
            Executing this request is permanent and irreversible.
          </p>
          {#if data.userEmail}
            <div class="mt-3">
              <TypedConfirmInput
                expectedValue={data.userEmail}
                label={`Type the exact email to confirm (${data.userEmail})`}
                inputId="erasure-execute-confirm"
                onMatchChange={(matches) => (typedMatches = matches)}
              />
            </div>
          {:else}
            <p class="mt-3 text-sm text-slate-700">
              This user's email could not be resolved (they may have already left the organization),
              so the typed-email confirmation below cannot be completed and execution is blocked.
              Contact support if this erasure request needs to proceed.
            </p>
          {/if}
          <div class="mt-3">
            <ConfirmDeleteButton
              label="Execute erasure"
              confirmLabel="Confirm execute erasure?"
              pendingLabel="Executing…"
              disabled={!typedMatches}
              onConfirm={onExecute}
            />
          </div>
          {#if executeError}
            <p class="mt-2 text-sm text-red-800" role="alert">{executeError}</p>
          {/if}
          {#if alreadyProcessing}
            <p class="mt-2 text-sm text-amber-800">
              {alreadyProcessing === 'completed'
                ? 'This erasure has already completed.'
                : 'This erasure is already being processed.'}
              <button type="button" class="ml-1 underline" onclick={() => void invalidateAll()}>
                Refresh
              </button>
            </p>
          {/if}
        </div>
      {:else}
        <p class="mt-6 text-sm text-slate-600">
          Only an organization owner can execute this erasure request.
        </p>
      {/if}
    </div>
  {:else if data.state === 'completed'}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-slate-950">Compliance Report</h2>
        <button
          type="button"
          class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
          onclick={onDownloadReport}
        >
          Download compliance report
        </button>
      </div>
      <p class="mt-1 text-sm text-slate-600">
        Executed at {new Date(data.report.executedAt).toLocaleString()}
      </p>

      <h3 class="mt-4 text-sm font-semibold text-slate-900">What was removed</h3>
      <ul class="mt-2 space-y-1 text-sm text-slate-700">
        {#each data.report.piiRemoved as entry (entry.table)}
          <li>{entry.table} — {entry.fields.join(', ')} — {entry.method}</li>
        {/each}
      </ul>

      <h3 class="mt-4 text-sm font-semibold text-slate-900">What was retained</h3>
      <ul class="mt-2 space-y-1 text-sm text-slate-700">
        {#each data.report.piiRetained as entry (entry.table)}
          <li>{entry.table} — {entry.reason}</li>
        {/each}
      </ul>

      <p class="mt-4 text-sm text-slate-700">
        <span class="font-semibold">Retention justification:</span>
        {data.report.retentionJustification}
      </p>

      <p class="mt-4 text-xs text-slate-500">Audit event: {data.report.auditEventId ?? '—'}</p>
    </div>
  {/if}
</div>
