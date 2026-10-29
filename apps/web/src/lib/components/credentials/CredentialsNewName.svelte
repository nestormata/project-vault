<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.11: the name field of the new secret form. The form owns the value (bindable).
  let {
    name = $bindable(),
    error,
    data,
  }: {
    name: string
    error?: string | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.name -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="credential-name">Name</label>
  <input
    id="credential-name"
    class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3"
    type="text"
    bind:value={name}
    autocomplete="off"
    required
    aria-describedby="credential-name-help"
  />
  <FormHelpText id="credential-name-help" kind="text" />
  {#if error}
    <p class="text-sm text-red-700">{error}</p>
  {/if}<InjectionPoint name="project.credentials-new.name" {data} />
</div>
