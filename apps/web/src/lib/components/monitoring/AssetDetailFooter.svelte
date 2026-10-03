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
    backNode,
    projectId,
  }: {
    canManage: boolean
    deleteError: string | null
    onDelete: () => void | Promise<void>
    deleteNote?: string
    confirmLabel?: string
    /** Story 68.7: the page's node in the `back` nav surface. */
    backNode: string
    projectId: string
  } = $props()
</script>

{#if canManage}
  <AssetDeletePanel note={deleteNote} {confirmLabel} {deleteError} {onDelete} />
{/if}

<BackLink node={backNode} {projectId} />
