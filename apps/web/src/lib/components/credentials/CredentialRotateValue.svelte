<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the single "New value" input of the start-rotation form as one replaceable region.
  let {
    form,
    data,
  }: {
    form: RotateFormController
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-rotate.value -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="rotation-new-value">New value</label>
  <textarea
    id="rotation-new-value"
    class="min-h-24 w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3 font-mono"
    bind:value={form.newValue}
    disabled={form.rotationActive}
    autocomplete="off"
    aria-describedby="rotation-new-value-help"></textarea>
  <FormHelpText id="rotation-new-value-help" kind="secret" />
  {#if form.valueError}
    <p class="text-sm text-red-700">{form.valueError}</p>
  {/if}<InjectionPoint name="project.credentials-rotate.value" {data} />
</div>
