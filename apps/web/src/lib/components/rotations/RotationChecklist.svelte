<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ChecklistItemRow from './ChecklistItemRow.svelte'
  import type { RotationDetailSectionProps } from './rotation-controller.svelte.js'

  // Story 69.14: the checklist card of the rotation detail page as one replaceable region. The
  // rows report back to the controller, which owns the working copy of the rotation.
  let { controller, rotation, data }: RotationDetailSectionProps = $props()
</script>

<!-- @region project.credentials-rotations-detail.checklist -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Checklist</h2>
  {#if rotation.checklistItems.length === 0}
    <p class="mt-3 text-sm text-slate-600">
      No dependent systems were recorded when this rotation started.
    </p>
  {:else}
    <ul class="mt-4 space-y-3">
      {#each rotation.checklistItems as item (item.id)}
        <ChecklistItemRow
          {item}
          projectId={controller.projectId}
          credentialId={controller.credentialId}
          rotationId={controller.rotationId}
          canAct={controller.canPerformItemActions}
          onUpdate={controller.handleItemUpdate}
          onConcurrentModification={controller.handleConcurrentModification}
        />
      {/each}
    </ul>
  {/if}<InjectionPoint name="project.credentials-rotations-detail.checklist" {data} />
</section>
