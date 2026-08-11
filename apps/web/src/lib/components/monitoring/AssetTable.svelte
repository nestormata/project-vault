<!--
  The table shell (card, <caption>, <thead>/<tbody>, column headers + a trailing "Actions" header
  when `canManage`) shared by the certificates/domains/services/service-endpoints list pages. Each
  page renders its own <tr> rows as children — only the header labels and row cells differ between
  asset types.
-->
<script lang="ts">
  // A column is either a plain label or a label plus a header class, so a page can pin a column's
  // width instead of letting content length shuffle the cells around.
  type AssetTableColumn = string | { label: string; headerClass?: string }

  let {
    caption,
    columns,
    canManage,
    children,
  }: {
    // Required rather than optional on purpose: an optional accessible name is the kind of
    // affordance that silently never gets passed.
    caption: string
    columns: ReadonlyArray<AssetTableColumn>
    canManage: boolean
    children: import('svelte').Snippet
  } = $props()

  const normalized = $derived(
    columns.map((column) => (typeof column === 'string' ? { label: column } : column))
  )
</script>

<div class="rounded-2xl border border-slate-200 bg-white shadow-sm">
  <!-- overflow-x-auto (not overflow-hidden) so wide rows scroll inside the card instead of being
       clipped or pushing the page body sideways at narrow widths. A scrollable region with no
       focusable content is unreachable by keyboard, hence the tabindex/role/label trio. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="overflow-x-auto rounded-2xl" role="region" aria-label={caption} tabindex="0">
    <table class="min-w-full text-left text-sm">
      <caption class="sr-only">{caption}</caption>
      <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
        <tr>
          <!-- Keyed by index, not label: a caller repeating a label is a cosmetic mistake, not a
               reason to throw each_key_duplicate and blank the route. -->
          {#each normalized as column, index (index)}
            <th scope="col" class={`px-4 py-3 font-semibold ${column.headerClass ?? ''}`.trim()}>
              {column.label}
            </th>
          {/each}
          {#if canManage}
            <th scope="col" class="px-4 py-3 font-semibold">Actions</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {@render children()}
      </tbody>
    </table>
  </div>
</div>
