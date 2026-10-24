<script lang="ts">
  import RotationIncompleteCheckbox from './RotationIncompleteCheckbox.svelte'
  import RotationNoDependenciesCheckbox from './RotationNoDependenciesCheckbox.svelte'
  import type { RotationController } from './rotation-controller.svelte.js'

  // Story 69.14: the acknowledgement a promote or retire needs before it may go ahead: the
  // zero-dependency confirmation when the rotation has no checklist, or the "go ahead although
  // not every system has confirmed" flag when some are still pending.
  let {
    controller,
    verb,
    helpId,
    incomplete = $bindable(false),
  }: {
    controller: RotationController
    verb: 'Promote' | 'Retire'
    helpId: string
    incomplete?: boolean
  } = $props()
</script>

{#if controller.totalCount === 0}
  <RotationNoDependenciesCheckbox bind:checked={controller.acknowledgedNoDependencies} />
{:else if !controller.allConfirmed}
  <RotationIncompleteCheckbox {verb} {helpId} bind:checked={incomplete} />
{/if}
