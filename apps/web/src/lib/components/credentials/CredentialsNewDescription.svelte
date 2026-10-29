<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.11: the description field of the new secret form. The form owns the value (bindable).
  let {
    description = $bindable(),
    data,
  }: {
    description: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.description -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="credential-description">Description</label>
  <textarea
    id="credential-description"
    class="min-h-24 w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3"
    bind:value={description}
    aria-describedby="credential-description-help"></textarea>
  <FormHelpText id="credential-description-help" kind="text" /><InjectionPoint
    name="project.credentials-new.description"
    {data}
  />
</div>
