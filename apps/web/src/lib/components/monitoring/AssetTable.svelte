<!--
  The table shell (card, <thead>/<tbody>, column headers + a trailing "Actions" header when
  `canManage`) shared by the certificates/domains/services list pages. Each page renders its own
  <tr> rows as children — only the header labels and row cells differ between asset types.
-->
<script lang="ts">
  let {
    columns,
    canManage,
    children,
  }: {
    columns: string[]
    canManage: boolean
    children: import('svelte').Snippet
  } = $props()
</script>

<div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
  <table class="min-w-full text-left text-sm">
    <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
      <tr>
        {#each columns as column (column)}
          <th class="px-4 py-3 font-semibold">{column}</th>
        {/each}
        {#if canManage}
          <th class="px-4 py-3 font-semibold">Actions</th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {@render children()}
    </tbody>
  </table>
</div>
