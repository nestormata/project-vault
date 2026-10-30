<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ShareDisplayStatus } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { shareDisplayStatusLabel } from '$lib/credentials/share-display-status.js'
  import { sharesIndexQuery } from './shares-index-query.js'

  // Story 72.11 AC1: the status filter. Chips are plain links, so a reload or a copied link keeps
  // the choice and no script is needed. The chosen chip is filled and also says "current filter"
  // in text for a screen reader (colour is never the only signal).
  let {
    displayStatus,
    data,
  }: {
    displayStatus: ShareDisplayStatus | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const FILTERS: readonly ShareDisplayStatus[] = [
    'active',
    'opened',
    'locked',
    'revoked',
    'expired',
  ]
  const CHIP = 'rounded-full border px-3 py-1 text-sm font-medium'
  const CHIP_ON = `${CHIP} border-slate-950 bg-slate-950 text-white`
  const CHIP_OFF = `${CHIP} border-slate-300 bg-white text-slate-800 hover:bg-slate-50`
</script>

<!-- @region shares.home.filter -->
<RegionFragment>
  <div
    role="group"
    aria-label={m.shares_index_filter_label()}
    class="flex flex-wrap items-center gap-2"
  >
    <a
      class={displayStatus === null ? CHIP_ON : CHIP_OFF}
      href="{resolve('/shares')}{sharesIndexQuery(null, 1)}"
      >{m.shares_index_filter_all()}{#if displayStatus === null}<span class="sr-only"
          >, {m.shares_index_filter_current()}</span
        >{/if}</a
    >
    {#each FILTERS as status (status)}
      <a
        class={displayStatus === status ? CHIP_ON : CHIP_OFF}
        href="{resolve('/shares')}{sharesIndexQuery(status, 1)}"
        >{shareDisplayStatusLabel(status)}{#if displayStatus === status}<span class="sr-only"
            >, {m.shares_index_filter_current()}</span
          >{/if}</a
      >
    {/each}<InjectionPoint name="shares.home.filter" {data} />
  </div>
</RegionFragment>
