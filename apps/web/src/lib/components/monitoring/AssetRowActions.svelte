<!--
  The "Edit" link + two-step delete button shown in each row of a monitored-asset list table.
  Shared by the certificates/domains/services list pages (service-endpoints uses its own card
  layout but still delegates to this for the actions themselves).
-->
<script lang="ts">
  import { resolve } from '$app/paths'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'

  let {
    editHref,
    confirmLabel,
    onDelete,
  }: {
    editHref: string
    confirmLabel?: string
    onDelete: () => void | Promise<void>
  } = $props()
</script>

<div class="flex items-center gap-2">
  <a class="font-medium text-slate-700 underline" href={resolve(editHref)}> Edit </a>
  <ConfirmDeleteButton {confirmLabel} onConfirm={onDelete} />
</div>
