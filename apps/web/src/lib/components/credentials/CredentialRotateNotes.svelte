<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the "Notes" input of the start-rotation form as one replaceable region.
  let {
    form,
    data,
  }: {
    form: RotateFormController
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-rotate.notes -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="rotation-notes">Notes</label>
  <textarea
    id="rotation-notes"
    class="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-3"
    bind:value={form.notes}
    aria-describedby="rotation-notes-help"></textarea>
  <FormHelpText id="rotation-notes-help" kind="text" /><InjectionPoint
    name="project.credentials-rotate.notes"
    {data}
  />
</div>
