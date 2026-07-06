<!--
  The tail of every monitored-asset detail page: the delete panel (only when `canManage`) followed
  by the "back to list" link. Shared by the certificates/domains/services/service-endpoints detail
  pages.
-->
<script lang="ts">
  import AssetDeletePanel from './AssetDeletePanel.svelte'
  import BackLink from './BackLink.svelte'

  let {
    canManage,
    deleteError,
    onDelete,
    deleteNote,
    confirmLabel,
    backHref,
    backLabel,
  }: {
    canManage: boolean
    deleteError: string | null
    onDelete: () => void | Promise<void>
    deleteNote?: string
    confirmLabel?: string
    backHref: string
    backLabel: string
  } = $props()
</script>

{#if canManage}
  <AssetDeletePanel note={deleteNote} {confirmLabel} {deleteError} {onDelete} />
{/if}

<BackLink href={backHref} label={backLabel} />
