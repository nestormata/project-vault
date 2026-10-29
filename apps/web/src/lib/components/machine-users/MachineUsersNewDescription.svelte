<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.12: the description field of the new machine user form. The form owns the value
  // (bindable).
  let {
    description = $bindable(),
    data,
  }: {
    description: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.machine-users-new.description -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="machine-user-description">
    Description
  </label>
  <textarea
    id="machine-user-description"
    class="min-h-24 w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3"
    bind:value={description}
    aria-describedby="machine-user-description-help"></textarea>
  <FormHelpText id="machine-user-description-help" kind="text" /><InjectionPoint
    name="project.machine-users-new.description"
    {data}
  />
</div>
