<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RotationAcknowledgement from './RotationAcknowledgement.svelte'
  import RotationMutationError from './RotationMutationError.svelte'
  import type { RotationSectionProps } from './rotation-controller.svelte.js'

  // Story 69.14: the "Promote" card (staged, admin and above) as one replaceable region.
  let { controller, data }: RotationSectionProps = $props()
</script>

<!-- @region project.credentials-rotations-detail.promote -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Promote</h2>
  <p class="mt-2 text-sm text-slate-600">
    Promoting makes the staged value the new current value. The old value moves to a Retire step you
    control separately.
  </p>
  <RotationAcknowledgement
    {controller}
    verb="Promote"
    helpId="rotation-promote-incomplete-help"
    bind:incomplete={controller.acknowledgeIncompleteChecklistForPromote}
  />
  <button
    type="button"
    class="mt-4 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
    disabled={controller.promoting ||
      controller.abandoning ||
      (controller.totalCount === 0
        ? !controller.acknowledgedNoDependencies
        : !controller.allConfirmed && !controller.acknowledgeIncompleteChecklistForPromote)}
    onclick={() => void controller.submitPromote()}
  >
    {controller.promoting ? 'Promoting…' : 'Promote'}
  </button>
  {#if controller.promoteError}
    <RotationMutationError
      message={controller.promoteError}
      pendingNames={controller.promotePendingItemNames}
    />
  {/if}<InjectionPoint name="project.credentials-rotations-detail.promote" {data} />
</section>
