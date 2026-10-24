<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: one labeled value input per selected field, as one replaceable region. It renders
  // once 2+ fields are checked and replaces the single shared textarea; the typed values live on
  // the form controller, so they survive the switch back to the single input.
  let {
    form,
    data,
  }: {
    form: RotateFormController
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- Story 13.5 AC-8: one labeled value input per selected field, replacing the single
     shared textarea once 2+ fields are checked. -->
<!-- @region project.credentials-rotate.field-values -->
<div class="space-y-4">
  {#each form.selectedFields as fieldKey (fieldKey)}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for={`rotation-value-${fieldKey}`}>
        {fieldKey}
      </label>
      <textarea
        id={`rotation-value-${fieldKey}`}
        class="min-h-16 w-full rounded-xl border border-slate-300 px-3 py-3 font-mono"
        value={form.fieldValues.get(fieldKey) ?? ''}
        oninput={(event) =>
          form.setFieldValue(fieldKey, (event.currentTarget as HTMLTextAreaElement).value)}
        disabled={form.rotationActive}
        autocomplete="off"
        aria-describedby={`rotation-value-help-${fieldKey}`}></textarea>
      <FormHelpText id={`rotation-value-help-${fieldKey}`} kind="secret" />
    </div>
  {/each}
  {#if form.valueError}
    <p class="text-sm text-red-700">{form.valueError}</p>
  {/if}<InjectionPoint name="project.credentials-rotate.field-values" {data} />
</div>
