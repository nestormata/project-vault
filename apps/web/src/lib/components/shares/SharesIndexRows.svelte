<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ShareIndexItem } from '$lib/api/credential-shares.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { formatDateTime } from '$lib/components/rotations/rotation-copy.js'
  import {
    shareDisplayStatusBadgeClass,
    shareDisplayStatusLabel,
  } from '$lib/credentials/share-display-status.js'

  // Story 72.11 AC1/AC2: one row per share. At 390 px each row is a card: the small caption above
  // every value shows below the `sm` breakpoint only, the desktop row reads as columns.
  let {
    items,
    data,
  }: { items: ShareIndexItem[]; data?: Record<string, readonly unknown[]> | undefined } = $props()

  const CAPTION = 'block text-xs text-slate-500 sm:hidden'
</script>

<!-- @region shares.home.items -->
<RegionFragment>
  <ul class="space-y-3">
    {#each items as share (share.id)}
      <li
        class="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-[2fr_2fr_1fr_1fr_auto] sm:items-center"
      >
        <span class="min-w-0">
          <span class={CAPTION}>{m.shares_index_col_credential()}</span>
          <a
            class="break-words font-semibold text-brand-700 underline"
            href={resolve(`/projects/${share.projectId}/credentials/${share.credentialId}`)}
          >
            {share.credentialName}
          </a>
          <span class="block text-xs text-slate-600">{share.projectName}</span>
        </span>
        <span class="min-w-0 break-words text-slate-800">
          <span class={CAPTION}>{m.shares_index_col_recipient()}</span>
          {#if share.recipientType === 'external'}
            {m.shares_index_recipient_external({ email: share.recipientEmail ?? '' })}
          {:else}
            {m.shares_index_recipient_member()}
          {/if}
        </span>
        <span class="text-slate-700">
          <span class={CAPTION}>{m.shares_index_col_created()}</span>
          {formatDateTime(share.createdAt)}
        </span>
        <span class="text-slate-700">
          <span class={CAPTION}>{m.shares_index_col_expires()}</span>
          {formatDateTime(share.expiresAt)}
        </span>
        <span>
          <span class={CAPTION}>{m.shares_index_col_status()}</span>
          <span class={shareDisplayStatusBadgeClass(share.displayStatus)}>
            {shareDisplayStatusLabel(share.displayStatus)}
          </span>
        </span>
      </li>
    {/each}<InjectionPoint name="shares.home.items" {data} />
  </ul>
</RegionFragment>
