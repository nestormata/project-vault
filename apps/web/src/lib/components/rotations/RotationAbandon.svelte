<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import AbandonRotationControl from './AbandonRotationControl.svelte'
  import type { RotationSectionProps } from './rotation-controller.svelte.js'

  // Story 69.14: the "Abandon" card (staged, admin and above) as one replaceable region. The
  // control reports its in-flight state to the controller, which the Promote button also reads.
  let { controller, data }: RotationSectionProps = $props()
</script>

<!-- @region project.credentials-rotations-detail.abandon -->
<section class="rounded-2xl border border-red-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Abandon</h2>
  <p class="mt-2 text-sm text-slate-600">
    Discard this staged rotation and keep the secret's previous value.
  </p>
  <div class="mt-4">
    <AbandonRotationControl
      projectId={controller.projectId}
      credentialId={controller.credentialId}
      rotationId={controller.rotationId}
      triggerLabel="Abandon rotation"
      confirmCopy="The staged (new) value is discarded and the secret keeps its previous value. This cannot be undone."
      disabled={controller.promoting}
      bind:submitting={controller.abandoning}
      onAbandoned={controller.handleAbandoned}
      onConcurrentModification={controller.handleConcurrentModification}
      onAlreadyPromoted={controller.refetch}
    /><InjectionPoint name="project.credentials-rotations-detail.abandon" {data} />
  </div>
</section>
