<script lang="ts">
  import DormancyThresholdOptions from '$lib/components/DormancyThresholdOptions.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { DormancyThresholdSave } from './dormancy-threshold-save.svelte.js'

  // Story 69.10: the threshold `<select>` and its help text, shared by the two dormancy regions so
  // the control and the element its `aria-describedby` names live in one file (the form-guidance
  // guard scans each file).
  let { id, helpId, threshold }: { id: string; helpId: string; threshold: DormancyThresholdSave } =
    $props()
</script>

<select
  {id}
  class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
  bind:value={threshold.choice}
  aria-describedby={helpId}
>
  <DormancyThresholdOptions />
</select>
<FormHelpText id={helpId} kind="select" />
