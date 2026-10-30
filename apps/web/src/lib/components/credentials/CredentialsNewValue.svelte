<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Story 69.11: the single-value field of the new secret form (shown when no template is chosen).
  // The form owns the value (bindable); it is never handed to a point.
  let {
    value = $bindable(),
    error,
    onAddCustomFields,
    data,
  }: {
    value: string
    error?: string | undefined
    // Story 72.10: turns the single value into a field list (custom template) so more fields can
    // be added without saving first.
    onAddCustomFields?: (() => void) | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.value -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="credential-value">Value</label>
  <input
    id="credential-value"
    class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3 font-mono"
    type="password"
    bind:value
    autocomplete="new-password"
    required
    aria-describedby="credential-value-help"
  />
  <FormHelpText id="credential-value-help" kind="secret" />
  {#if error}
    <p class="text-sm text-red-700">{error}</p>
  {/if}
  {#if onAddCustomFields}
    <button
      class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2 text-sm font-medium"
      type="button"
      aria-describedby="credential-add-custom-fields-help"
      onclick={onAddCustomFields}
    >
      {m.credential_new_add_custom_fields()}
    </button>
    <FormHelpText
      id="credential-add-custom-fields-help"
      text={m.credential_new_add_custom_fields_help()}
    />
  {/if}<InjectionPoint name="project.credentials-new.value" {data} />
</div>
