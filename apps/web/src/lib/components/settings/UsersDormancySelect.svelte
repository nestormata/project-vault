<script lang="ts">
  import DormancyThresholdOptions from '$lib/components/DormancyThresholdOptions.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { DormancyThresholdSave } from './dormancy-threshold-save.svelte.js'

  // Story 69.10: the threshold `<select>` and its help text, shared by the two dormancy regions so
  // the control and the element its `aria-describedby` names live in one file (the form-guidance
  // guard scans each file).
  let { id, helpId, threshold }: { id: string; helpId: string; threshold: DormancyThresholdSave } =
    $props()
  // One spread keeps the server-rendered attribute order of the original markup (id, class), which the byte-identical render oracles pin.
  const attributes = $derived({
    id,
    class: 'rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2 text-sm',
  })
</script>

<select {...attributes} aria-describedby={helpId} bind:value={threshold.choice}>
  <DormancyThresholdOptions />
</select>
<FormHelpText id={helpId} kind="select" />
