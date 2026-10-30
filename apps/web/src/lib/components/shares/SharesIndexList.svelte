<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import type { ShareDisplayStatus } from '@project-vault/shared'
  import type { ShareIndexItem } from '$lib/api/credential-shares.js'
  import { m } from '$lib/paraglide/messages.js'
  import { formatDateTime } from '$lib/components/rotations/rotation-copy.js'
  import {
    shareDisplayStatusBadgeClass,
    shareDisplayStatusLabel,
  } from '$lib/credentials/share-display-status.js'
  import { sharesIndexQuery } from './shares-index-query.js'

  // Story 72.11 AC1: the filter (chips that are plain links, so a reload or a copied link keeps the
  // choice), the shares as one list of rows that become cards at 390 px, and the pagination links.
  let {
    items,
    total,
    page,
    pageSize,
    displayStatus,
    children,
  }: {
    items: ShareIndexItem[]
    total: number
    page: number
    pageSize: number
    displayStatus: ShareDisplayStatus | null
    children?: Snippet
  } = $props()

  const FILTERS: readonly ShareDisplayStatus[] = [
    'active',
    'opened',
    'locked',
    'revoked',
    'expired',
  ]

  const first = $derived((page - 1) * pageSize + 1)
  const last = $derived(Math.min(total, (page - 1) * pageSize + items.length))
  const hasNext = $derived(page * pageSize < total)
  const CHIP = 'rounded-full border px-3 py-1 text-sm font-medium'
  const CHIP_ON = `${CHIP} border-slate-950 bg-slate-950 text-white`
  const CHIP_OFF = `${CHIP} border-slate-300 bg-white text-slate-800 hover:bg-slate-50`
</script>

{@render children?.()}
<nav aria-label={m.shares_index_filter_label()} class="flex flex-wrap items-center gap-2">
  <a
    class={displayStatus === null ? CHIP_ON : CHIP_OFF}
    aria-current={displayStatus === null ? 'page' : undefined}
    href="{resolve('/shares')}{sharesIndexQuery(null, 1)}">{m.shares_index_filter_all()}</a
  >
  {#each FILTERS as status (status)}
    <a
      class={displayStatus === status ? CHIP_ON : CHIP_OFF}
      aria-current={displayStatus === status ? 'page' : undefined}
      href="{resolve('/shares')}{sharesIndexQuery(status, 1)}">{shareDisplayStatusLabel(status)}</a
    >
  {/each}
</nav>

{#if items.length === 0}
  <p class="rounded-2xl border border-slate-200 bg-white p-6 text-slate-700">
    {m.shares_index_empty()}
  </p>
{:else}
  <p class="text-sm text-slate-600">
    {m.shares_index_showing({ from: first, to: last, total })}
  </p>
  <ul class="space-y-3">
    {#each items as share (share.id)}
      <li
        class="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-[2fr_2fr_1fr_1fr_auto] sm:items-center"
      >
        <span class="min-w-0">
          <span class="block text-xs text-slate-500 sm:hidden"
            >{m.shares_index_col_credential()}</span
          >
          <a
            class="break-words font-semibold text-brand-700 underline"
            href={resolve(`/projects/${share.projectId}/credentials/${share.credentialId}`)}
          >
            {share.credentialName}
          </a>
          <span class="block text-xs text-slate-600">{share.projectName}</span>
        </span>
        <span class="min-w-0 break-words text-slate-800">
          <span class="block text-xs text-slate-500 sm:hidden"
            >{m.shares_index_col_recipient()}</span
          >
          {#if share.recipientType === 'external'}
            {m.shares_index_recipient_external({ email: share.recipientEmail ?? '' })}
          {:else}
            {m.shares_index_recipient_member()}
          {/if}
        </span>
        <span class="text-slate-700">
          <span class="block text-xs text-slate-500 sm:hidden">{m.shares_index_col_created()}</span>
          {formatDateTime(share.createdAt)}
        </span>
        <span class="text-slate-700">
          <span class="block text-xs text-slate-500 sm:hidden">{m.shares_index_col_expires()}</span>
          {formatDateTime(share.expiresAt)}
        </span>
        <span>
          <span class="block text-xs text-slate-500 sm:hidden">{m.shares_index_col_status()}</span>
          <span class={shareDisplayStatusBadgeClass(share.displayStatus)}>
            {shareDisplayStatusLabel(share.displayStatus)}
          </span>
        </span>
      </li>
    {/each}
  </ul>
  <div class="flex items-center gap-4">
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
    {/if}
  </div>
{/if}
