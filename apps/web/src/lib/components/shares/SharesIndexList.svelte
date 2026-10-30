<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { ShareDisplayStatus } from '@project-vault/shared'
  import type { ShareIndexItem } from '$lib/api/credential-shares.js'
  import SharesIndexEmpty from './SharesIndexEmpty.svelte'
  import SharesIndexFilter from './SharesIndexFilter.svelte'
  import SharesIndexPagination from './SharesIndexPagination.svelte'
  import SharesIndexRows from './SharesIndexRows.svelte'

  // Story 72.11 AC1: the filter, then the empty state or the rows and the pagination, each its own
  // sub-region. The route owns the data; `data` is its `__inject` map.
  let {
    items,
    total,
    page,
    pageSize,
    displayStatus,
    data,
    children,
  }: {
    items: ShareIndexItem[]
    total: number
    page: number
    pageSize: number
    displayStatus: ShareDisplayStatus | null
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
<SharesIndexFilter {displayStatus} {data} />
{#if items.length === 0}
  <SharesIndexEmpty {data} />
{:else}
  <SharesIndexRows {items} {data} />
  <SharesIndexPagination {total} {page} {pageSize} shown={items.length} {displayStatus} {data} />
{/if}
