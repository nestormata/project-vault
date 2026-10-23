<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { DormancyThresholdDays } from '$lib/api/organization-settings.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { DormancyThresholdSave } from './dormancy-threshold-save.svelte.js'

  // Story 69.10: the card both dormancy threshold regions of the users page render (machine key and
  // user): a "set a new value" select with a save button, its outcome, and the region's point as
  // `children` right after the outcome. The save call and the copy come from the region.
  let {
    spacing,
    heading,
    description,
    notice,
    label,
    labelFor,
    select,
    helpId,
    saveLabel,
    save,
    children,
  }: {
    spacing: string
    heading: string
    description: string
    notice: string
    label: string
    labelFor: string
    /** The `<select>` itself, written statically by the region so its attributes keep their order. */
    select: Snippet<[DormancyThresholdSave]>
    helpId: string
    saveLabel: string
    save: (days: DormancyThresholdDays) => Promise<number>
    children?: Snippet
  } = $props()

  const threshold = new DormancyThresholdSave((days) => save(days))
</script>

<div class={`${spacing} rounded-2xl border border-slate-200 bg-white p-6 shadow-sm`}>
  <h2 class="text-lg font-semibold text-slate-950">{heading}</h2>
  <p class="mt-2 text-sm text-slate-600">{description}</p>
  <p class="mt-2 text-sm font-medium text-amber-800">{notice}</p>
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <label class="sr-only" for={labelFor}>{label}</label>
    {@render select(threshold)}
    <FormHelpText id={helpId} kind="select" />
    <button
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      type="button"
      disabled={threshold.saving || threshold.choice === ''}
      onclick={() => void threshold.submit()}
    >
      {threshold.saving ? 'Saving…' : saveLabel}
    </button>
  </div>
  {#if threshold.savedTo !== null}
    <p class="mt-2 text-sm text-emerald-700">
      Threshold updated to {threshold.savedTo} days.
    </p>
  {/if}
  {#if threshold.error}
    <p class="mt-2 text-sm text-red-700" role="alert">{threshold.error}</p>
  {/if}{@render children?.()}
</div>
