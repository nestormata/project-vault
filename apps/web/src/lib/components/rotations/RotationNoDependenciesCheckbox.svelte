<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.14: the zero-dependency acknowledgement shared by the complete, promote and retire
  // sections (the three never render together).
  let { checked = $bindable(false) }: { checked?: boolean } = $props()
</script>

<label class="mt-3 flex items-start gap-2 text-sm text-slate-800">
  <input type="checkbox" bind:checked aria-describedby="rotation-no-dependencies-help" />
  I confirm this secret is updated in all consuming systems
  <FormHelpText id="rotation-no-dependencies-help" kind="checkbox" />
</label>
