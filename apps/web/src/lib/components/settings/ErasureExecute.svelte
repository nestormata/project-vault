<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { ApiClientError } from '$lib/api/client.js'
  import { executeErasure } from '$lib/api/compliance.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import TypedConfirmInput from '$lib/components/forms/TypedConfirmInput.svelte'

  // Story 69.11: the execute zone of a pending erasure request (owner only). It owns the confirm,
  // busy and error state of the execution; nothing else on the page reads it.
  let {
    orgRole,
    userId,
    requestId,
    userEmail,
    data,
  }: {
    orgRole: string
    userId: string
    requestId: string
    userEmail: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

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
      await executeErasure(fetch, userId, requestId)
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
</script>

<!-- @region settings.users-erasure-detail.execute -->
<RegionFragment>
  {#if orgRole === 'owner'}
    <div class="mt-6 rounded-xl border border-red-200 bg-red-50 p-4">
      <p class="text-sm font-semibold text-red-800">
        Executing this request is permanent and irreversible.
      </p>
      {#if userEmail}
        <div class="mt-3">
          <TypedConfirmInput
            expectedValue={userEmail}
            label={`Type the exact email to confirm (${userEmail})`}
            inputId="erasure-execute-confirm"
            onMatchChange={(matches) => (typedMatches = matches)}
          />
        </div>
      {:else}
        <p class="mt-3 text-sm text-slate-700">
          This user's email could not be resolved (they may have already left the organization), so
          the typed-email confirmation below cannot be completed and execution is blocked. Contact
          support if this erasure request needs to proceed.
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
  {/if}<InjectionPoint name="settings.users-erasure-detail.execute" {data} />
</RegionFragment>
