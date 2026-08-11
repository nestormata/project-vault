<script lang="ts">
  let {
    paused,
    pausedAt,
    lastKnownStatus,
    canManage,
    submitting = false,
    errorMessage = null,
    idSuffix = 'detail',
    variant = 'card',
    onToggle,
  }: {
    paused: boolean
    pausedAt: string | null
    lastKnownStatus: string
    canManage: boolean
    submitting?: boolean
    errorMessage?: string | null
    idSuffix?: string
    // Story 18.13: 'row' is a compact rendering for a monitored-asset table cell — same state,
    // same confirmation flow, no per-row <h2> or card chrome. 'card' is the detail-page form.
    variant?: 'card' | 'row'
    onToggle: (paused: boolean) => boolean | Promise<boolean>
  } = $props()

  let confirming = $state(false)
  let trigger = $state<HTMLButtonElement | null>(null)

  function formatDateTime(value: string): string {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  function statusLabel(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1)
  }

  function openConfirmation(event: MouseEvent): void {
    if (!canManage || submitting) return
    trigger = event.currentTarget as HTMLButtonElement
    confirming = true
  }

  function cancelConfirmation(): void {
    confirming = false
    trigger?.focus()
  }

  async function confirmChange(): Promise<void> {
    if (submitting) return
    const success = await onToggle(!paused)
    if (success) {
      confirming = false
      trigger?.focus()
    }
  }
</script>

{#snippet pausedCardCopy()}
  Last known status: <strong>{statusLabel(lastKnownStatus)}</strong>. No new probes, health history,
  alerts, or notifications are created while paused.
{/snippet}

{#snippet toggleButton(extraClass: string)}
  {#if canManage}
    <button
      class={`rounded-lg border border-slate-400 font-medium text-slate-800 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:cursor-wait disabled:opacity-60 ${extraClass}`}
      type="button"
      disabled={submitting}
      aria-haspopup="dialog"
      onclick={openConfirmation}
    >
      {submitting ? 'Saving…' : paused ? 'Resume monitoring' : 'Pause monitoring'}
    </button>
  {/if}
{/snippet}

{#snippet viewerNote(extraClass: string)}
  {#if !canManage && paused}
    <p class={`text-slate-700 ${extraClass}`}>
      You can view this state, but your role cannot change it.
    </p>
  {/if}
{/snippet}

{#snippet errorNote(extraClass: string)}
  {#if errorMessage}
    <p class={`text-red-700 ${extraClass}`} role="alert">{errorMessage}</p>
  {/if}
{/snippet}

{#if variant === 'row'}
  <!-- Table-cell rendering: a labelled group carries the state name a <h2> would carry on the
       detail page, so a row never injects a heading into the page outline. -->
  <div class="space-y-1" role="group" aria-labelledby={`monitoring-state-heading-${idSuffix}`}>
    <p id={`monitoring-state-heading-${idSuffix}`} class="font-medium text-slate-900">
      {paused ? 'Monitoring paused' : 'Monitoring active'}
    </p>
    {#if paused}
      <p class="text-xs text-slate-600">
        Last known status: <strong>{statusLabel(lastKnownStatus)}</strong>
      </p>
      {#if pausedAt}
        <p class="text-xs text-slate-600">Paused {formatDateTime(pausedAt)}</p>
      {/if}
    {/if}
    {@render toggleButton('px-2 py-1 text-xs')}
    {@render viewerNote('text-xs')}
    {@render errorNote('text-xs')}
  </div>
{:else}
  <section
    class={`rounded-2xl border p-4 ${paused ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}
    aria-labelledby={`monitoring-state-heading-${idSuffix}`}
  >
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id={`monitoring-state-heading-${idSuffix}`} class="font-semibold text-slate-950">
          {paused ? 'Monitoring paused' : 'Monitoring active'}
        </h2>
        <p class="mt-1 text-sm text-slate-700">
          {#if paused}
            {@render pausedCardCopy()}
          {:else}
            Checks run according to the configured schedule. The status below is the latest recorded
            check.
          {/if}
        </p>
        {#if paused && pausedAt}
          <p class="mt-1 text-xs text-slate-600">Paused {formatDateTime(pausedAt)}</p>
        {/if}
      </div>

      {@render toggleButton('px-3 py-2 text-sm')}
    </div>

    {@render viewerNote('mt-3 text-sm')}
    {@render errorNote('mt-3 text-sm')}
  </section>
{/if}

{#if confirming}
  <div class="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" role="presentation">
    <div
      class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`monitoring-confirm-title-${idSuffix}`}
      aria-describedby={`monitoring-confirm-description-${idSuffix}`}
      tabindex="-1"
      onkeydown={(event) => event.key === 'Escape' && cancelConfirmation()}
    >
      <h2 id={`monitoring-confirm-title-${idSuffix}`} class="text-lg font-semibold text-slate-950">
        {paused ? 'Resume monitoring?' : 'Pause monitoring?'}
      </h2>
      <p id={`monitoring-confirm-description-${idSuffix}`} class="mt-3 text-sm text-slate-700">
        {#if paused}
          Checks will run again according to the configured schedule and may be due immediately.
          Existing status, history, and alerts remain unchanged.
        {:else}
          Future probes, health-history rows, alerts, and notifications will stop. Existing status,
          history, and alerts remain available; nothing is deleted or resolved.
        {/if}
      </p>
      <div class="mt-5 flex justify-end gap-3">
        <button
          class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500"
          type="button"
          onclick={cancelConfirmation}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          class="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:cursor-wait disabled:opacity-60"
          type="button"
          onclick={() => void confirmChange()}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : paused ? 'Resume monitoring' : 'Pause monitoring'}
        </button>
      </div>
    </div>
  </div>
{/if}
