<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the inline "identical value, rotate anyway?" prompt as one replaceable region,
  // shown instead of the generic error banner when the server answers 409
  // same_value_confirmation_required (Story 13.5 AC-3).
  let {
    form,
    data,
  }: {
    form: RotateFormController
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-rotate.same-value-confirm -->
<RegionFragment>
  <div
    class="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
    role="alert"
  >
    <p>
      The new value for
      {#if form.sameValueConfirmField}
        <code class="font-mono">{form.sameValueConfirmField}</code>
      {:else}
        the secret
      {/if}
      is identical to its current value. Rotate anyway?
    </p>
    <div class="flex gap-3">
      <button
        type="button"
        class="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
        disabled={form.submitting}
        onclick={() => void form.confirmSameValueRotation()}
      >
        Confirm
      </button>
      <button
        type="button"
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-3 py-2 text-sm font-semibold text-slate-800"
        onclick={() => form.cancelSameValueConfirmation()}
      >
        Cancel
      </button>
    </div>
  </div>
  <InjectionPoint name="project.credentials-rotate.same-value-confirm" {data} />
</RegionFragment>
