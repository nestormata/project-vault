<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.12: the name field of the new project form. The form owns the value and the slug
  // suggestion that follows it.
  let {
    name,
    error,
    onInput,
    data,
  }: {
    name: string
    error?: string | undefined
    onInput: (value: string) => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.new.name -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="project-name">Name</label>
  <input
    class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3"
    id="project-name"
    type="text"
    value={name}
    maxlength="128"
    required
    oninput={(event) => onInput(event.currentTarget.value)}
    aria-describedby="project-name-help"
  />
  <FormHelpText id="project-name-help" kind="text" />
  {#if error}
    <p class="text-sm text-red-700">{error}</p>
  {/if}<InjectionPoint name="project.new.name" {data} />
</div>
