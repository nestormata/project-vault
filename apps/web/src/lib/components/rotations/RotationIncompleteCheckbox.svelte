<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.14: the "go ahead although not every system has confirmed" acknowledgement of the
  // promote and retire sections (`verb` is "Promote" or "Retire").
  let {
    verb,
    helpId,
    checked = $bindable(false),
  }: { verb: 'Promote' | 'Retire'; helpId: string; checked?: boolean } = $props()
</script>

<label class="mt-3 flex items-start gap-2 text-sm text-slate-800">
  <input type="checkbox" bind:checked aria-describedby={helpId} />
  {verb} even though not every system has confirmed yet
  <FormHelpText id={helpId} kind="checkbox" />
</label>
