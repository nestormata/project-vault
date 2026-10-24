<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.12: the description field of the new project form. The form owns the value (bindable).
  let {
    description = $bindable(),
    error,
    data,
  }: {
    description: string
    error?: string | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.new.description -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="project-description">Description</label>
  <textarea
    class="min-h-28 w-full rounded-xl border border-slate-300 px-3 py-3"
    id="project-description"
    bind:value={description}
    maxlength="512"
    aria-describedby="project-description-help"></textarea>
  <FormHelpText id="project-description-help" kind="text" />
  {#if error}
    <p class="text-sm text-red-700">{error}</p>
  {/if}<InjectionPoint name="project.new.description" {data} />
</div>
