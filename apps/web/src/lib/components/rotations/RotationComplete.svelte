<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RotationMutationError from './RotationMutationError.svelte'
  import RotationNoDependenciesCheckbox from './RotationNoDependenciesCheckbox.svelte'
  import type { RotationSectionProps } from './rotation-controller.svelte.js'

  // Story 69.14: the "Complete rotation" card (in_progress, admin and above) as one replaceable
  // region.
  let { controller, data }: RotationSectionProps = $props()
</script>

<!-- @region project.credentials-rotations-detail.complete -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Complete rotation</h2>
  {#if controller.totalCount === 0}
    <RotationNoDependenciesCheckbox bind:checked={controller.acknowledgedNoDependencies} />
  {/if}
  <button
    type="button"
    class="mt-4 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
    disabled={controller.completing ||
      (controller.totalCount === 0
        ? !controller.acknowledgedNoDependencies
        : !controller.allConfirmed)}
    onclick={() => void controller.submitComplete()}
  >
    {controller.completing ? 'Completing…' : 'Complete rotation'}
  </button>
  {#if controller.totalCount > 0 && !controller.allConfirmed}
    <p class="mt-2 text-sm text-slate-600">
      {controller.totalCount - controller.confirmedCount} system(s) still need confirmation.
    </p>
  {/if}
  {#if controller.completeError}
    <RotationMutationError
      message={controller.completeError}
      pendingNames={controller.pendingItemNames}
    />
  {/if}<InjectionPoint name="project.credentials-rotations-detail.complete" {data} />
</section>
