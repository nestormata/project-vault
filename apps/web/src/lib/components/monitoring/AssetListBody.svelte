<script lang="ts">
  import type { Snippet } from 'svelte'
  import AssetTable from './AssetTable.svelte'
  import EmptyAssetState from './EmptyAssetState.svelte'
  import FormErrorBanner from './FormErrorBanner.svelte'
  import ProjectNotFoundBanner from './ProjectNotFoundBanner.svelte'

  // Story 69.5: the body every monitored-asset list page shares (project not found, empty state, or
  // the delete error above the table). Only the row markup differs per asset type.
  let {
    notFound,
    isEmpty,
    emptyMessage,
    deleteError,
    caption,
    columns,
    canManage,
    rows,
  }: {
    notFound: boolean | undefined
    isEmpty: boolean
    emptyMessage: string
    deleteError: string | null
    caption: string
    columns: string[]
    canManage: boolean
    rows: Snippet
  } = $props()
</script>

{#if notFound}
  <ProjectNotFoundBanner />
{:else if isEmpty}
  <EmptyAssetState message={emptyMessage} />
{:else}
  <FormErrorBanner message={deleteError} />
  <AssetTable {caption} {columns} {canManage}>
    {@render rows()}
  </AssetTable>
{/if}
