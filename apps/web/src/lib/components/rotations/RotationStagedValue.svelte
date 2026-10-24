<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { RotationSectionProps } from './rotation-controller.svelte.js'

  // Story 69.14: the independently-retrievable staged value (Story 5.6 AC-8) as one replaceable
  // region. The revealed value lives on the controller, so abandon and retire can clear it.
  let { controller, data }: RotationSectionProps = $props()
</script>

<!-- @region project.credentials-rotations-detail.staged-value -->
<RegionFragment>
  <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-950">Staged value</h2>
    <p class="mt-2 text-sm text-slate-600">
      The new value is independently retrievable while staged, so dependent systems can be updated
      ahead of promotion.
    </p>
    {#if controller.stagedValue}
      <p
        class="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-sm break-all"
      >
        {controller.stagedValue}
      </p>
    {:else}
      <button
        type="button"
        class="mt-3 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-60"
        disabled={controller.revealingStagedValue}
        onclick={() => void controller.revealStagedValue()}
      >
        {controller.revealingStagedValue ? 'Revealing…' : 'Reveal staged value'}
      </button>
    {/if}
    {#if controller.stagedValueError}
      <p class="mt-2 text-sm text-red-800" role="alert">{controller.stagedValueError}</p>
    {/if}<InjectionPoint name="project.credentials-rotations-detail.staged-value" {data} />
  </section>
</RegionFragment>
