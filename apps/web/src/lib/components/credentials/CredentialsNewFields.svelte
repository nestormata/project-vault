<script lang="ts">
  import type { FieldDraft } from '$lib/components/onboarding/onboarding-logic.js'
  import FieldSetEditor from '$lib/components/credentials/FieldSetEditor.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  // Story 69.11: the structured field set of the new secret form (shown when a template is chosen).
  // The form owns the drafts (bindable) and the add/remove callbacks.
  let {
    fields = $bindable(),
    errors,
    multilineValue,
    onAdd,
    onRemove,
    data,
  }: {
    fields: FieldDraft[]
    errors: Record<number, string>
    multilineValue: boolean
    onAdd: () => void
    onRemove: (index: number) => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.fields -->
<fieldset class="space-y-3">
  <legend class="font-medium text-slate-900">Fields</legend>
  {#if fields.length === 0}
    <p class="text-sm text-slate-600">
      This template starts empty — add at least one field before saving.
    </p>
  {/if}
  <FieldSetEditor bind:fields {errors} {multilineValue} {onAdd} {onRemove} /><InjectionPoint
    name="project.credentials-new.fields"
    {data}
  />
</fieldset>
