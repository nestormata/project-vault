<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    submitLabel,
    pendingLabel,
    cancelHref,
    submitting = false,
  }: {
    submitLabel: string
    pendingLabel: string
    cancelHref: string
    submitting?: boolean
  } = $props()
</script>

<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
  <button
    class="rounded-xl bg-slate-950 px-4 py-3 font-semibold text-white disabled:opacity-60"
    type="submit"
    disabled={submitting}
  >
    {submitting ? pendingLabel : submitLabel}
  </button>
  <a class="text-center font-medium text-slate-700 underline" href={resolve(cancelHref)}>Cancel</a>
</div>
