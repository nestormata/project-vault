<!--
  The delete panel shown near the bottom of a monitored-asset detail page: an optional note, an
  inline delete-error banner, and the two-step ConfirmDeleteButton. Shared by the certificates/
  domains/services/service-endpoints detail pages.
-->
<script lang="ts">
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'

  let {
    note,
    deleteError,
    confirmLabel,
    onDelete,
  }: {
    note?: string
    deleteError: string | null
    confirmLabel?: string
    onDelete: () => void | Promise<void>
  } = $props()
</script>

<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  {#if note}
    <p class="mb-3 text-sm text-slate-600">{note}</p>
  {/if}
  {#if deleteError}
    <p class="mb-3 text-sm text-red-700" role="alert">{deleteError}</p>
  {/if}
  <ConfirmDeleteButton {confirmLabel} onConfirm={onDelete} />
</div>
