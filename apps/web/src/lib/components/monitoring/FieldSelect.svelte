<!--
  A single labeled <select> with numeric options, in the shape monitored-asset forms use (today:
  only the service-endpoint check-frequency dropdown, shared between its new/+page.svelte and
  [id]/+page.svelte forms).
-->
<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  let {
    id,
    label,
    options,
    value = $bindable(),
  }: {
    id: string
    label: string
    options: readonly number[]
    value: number
  } = $props()
</script>

<div class="space-y-2">
  <label class="block font-medium text-slate-900" for={id}>{label}</label>
  <select
    {id}
    class="w-full rounded-xl border border-slate-300 px-3 py-3"
    bind:value
    aria-describedby={`${id}-help`}
  >
    {#each options as option (option)}
      <option value={option}>{option}</option>
    {/each}
  </select>
  <FormHelpText id={`${id}-help`} kind="select" />
</div>
