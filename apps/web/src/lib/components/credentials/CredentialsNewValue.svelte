<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.11: the single-value field of the new secret form (shown when no template is chosen).
  // The form owns the value (bindable); it is never handed to a point.
  let {
    value = $bindable(),
    error,
    data,
  }: {
    value: string
    error?: string | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.value -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="credential-value">Value</label>
  <input
    id="credential-value"
    class="w-full rounded-xl border border-slate-300 px-3 py-3 font-mono"
    type="password"
    bind:value
    autocomplete="new-password"
    required
    aria-describedby="credential-value-help"
  />
  <FormHelpText id="credential-value-help" kind="secret" />
  {#if error}
    <p class="text-sm text-red-700">{error}</p>
  {/if}<InjectionPoint name="project.credentials-new.value" {data} />
</div>
