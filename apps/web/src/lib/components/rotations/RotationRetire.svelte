<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RotationAcknowledgement from './RotationAcknowledgement.svelte'
  import RotationMutationError from './RotationMutationError.svelte'
  import type { RotationSectionProps } from './rotation-controller.svelte.js'

  // Story 69.14: the "Retire" card (promoted, admin and above) as one replaceable region.
  let { controller, data }: RotationSectionProps = $props()
</script>

<!-- @region project.credentials-rotations-detail.retire -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Retire</h2>
  <p class="mt-2 text-sm text-slate-600">
    Retiring cryptographically deletes the old value. This is irreversible — retire only once every
    dependent system has switched to the new value.
  </p>
  <RotationAcknowledgement
    {controller}
    verb="Retire"
    helpId="rotation-retire-incomplete-help"
    bind:incomplete={controller.acknowledgeIncompleteChecklistForRetire}
  />
  <button
    type="button"
    class="mt-4 rounded-xl bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
    disabled={controller.retiring ||
      (controller.totalCount === 0
        ? !controller.acknowledgedNoDependencies
        : !controller.allConfirmed && !controller.acknowledgeIncompleteChecklistForRetire)}
    onclick={() => void controller.submitRetire()}
  >
    {controller.retiring ? 'Retiring…' : 'Retire old value'}
  </button>
  {#if controller.retireError}
    <RotationMutationError
      message={controller.retireError}
      pendingNames={controller.retirePendingItemNames}
    />
  {/if}<InjectionPoint name="project.credentials-rotations-detail.retire" {data} />
</section>
