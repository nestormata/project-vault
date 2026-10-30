<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ShareDisplayStatus } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { sharesIndexQuery } from './shares-index-query.js'

  // Story 72.11: the count line and the Previous and Next links (the filter is kept).
  let {
    total,
    page,
    pageSize,
    shown,
    displayStatus,
    data,
  }: {
    total: number
    page: number
    pageSize: number
    shown: number
    displayStatus: ShareDisplayStatus | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const first = $derived((page - 1) * pageSize + 1)
  const last = $derived(Math.min(total, (page - 1) * pageSize + shown))
  const hasNext = $derived(page * pageSize < total)
</script>

<!-- @region shares.home.pagination -->
<RegionFragment>
  <div class="flex flex-wrap items-center gap-4">
    <p class="text-sm text-slate-600">{m.shares_index_showing({ from: first, to: last, total })}</p>
    {#if page > 1}
      <a
        class="text-sm font-medium text-slate-800 underline"
        href="{resolve('/shares')}{sharesIndexQuery(displayStatus, page - 1)}"
        >{m.shares_index_previous()}</a
      >
    {/if}
    {#if hasNext}
      <a
        class="text-sm font-medium text-slate-800 underline"
        href="{resolve('/shares')}{sharesIndexQuery(displayStatus, page + 1)}"
        >{m.shares_index_next()}</a
      >
    {/if}<InjectionPoint name="shares.home.pagination" {data} />
  </div>
</RegionFragment>
