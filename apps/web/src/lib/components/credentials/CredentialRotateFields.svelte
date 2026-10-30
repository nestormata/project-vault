<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the "Fields to rotate" selector of the start-rotation form as one replaceable
  // region. Its state lives on the form controller (the value inputs read the same selection).
  let {
    form,
    data,
  }: {
    form: RotateFormController
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-rotate.fields -->
<div class="space-y-3">
  <p class="block font-medium text-slate-900">Fields to rotate</p>
  <div class="flex gap-4 text-sm">
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="rotation-mode"
        value="whole"
        checked={form.rotationMode === 'whole'}
        disabled={form.rotationActive || form.hasTotpField}
        onchange={() => (form.rotationMode = 'whole')}
        aria-describedby="rotation-mode-help"
      />
      Rotate whole secret
    </label>
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="rotation-mode"
        value="specific"
        checked={form.rotationMode === 'specific'}
        disabled={form.rotationActive}
        onchange={() => (form.rotationMode = 'specific')}
        aria-describedby="rotation-mode-help"
      />
      Specific fields
    </label>
  </div>
  <FormHelpText id="rotation-mode-help" kind="radio" />
  {#if form.rotationMode === 'specific'}
    <ul class="space-y-1">
      {#each form.fieldMeta as field (field.key)}
        <li>
          <label class="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              aria-label={field.key}
              checked={form.selectedFields.includes(field.key)}
              disabled={form.rotationActive}
              onchange={() => form.toggleField(field.key)}
              aria-describedby={`rotation-field-help-${field.key}`}
            />
            <FormHelpText id={`rotation-field-help-${field.key}`} kind="checkbox" />
            {field.key}
          </label>
        </li>
      {/each}
    </ul>
    {#if form.fieldSelectionError}
      <p class="text-sm text-red-700">{form.fieldSelectionError}</p>
    {/if}
  {/if}<InjectionPoint name="project.credentials-rotate.fields" {data} />
</div>
