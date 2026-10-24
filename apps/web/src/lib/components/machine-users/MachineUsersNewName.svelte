<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.12: the name field of the new machine user form. The form owns the value (bindable).
  let {
    name = $bindable(),
    data,
  }: {
    name: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.machine-users-new.name -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="machine-user-name">Name</label>
  <input
    id="machine-user-name"
    class="w-full rounded-xl border border-slate-300 px-3 py-3"
    type="text"
    bind:value={name}
    autocomplete="off"
    required
    aria-describedby="machine-user-name-help"
  />
  <FormHelpText id="machine-user-name-help" kind="text" /><InjectionPoint
    name="project.machine-users-new.name"
    {data}
  />
</div>
