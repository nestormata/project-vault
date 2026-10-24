<script lang="ts">
  import type { PiiInventory } from '$lib/api/compliance.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the PII inventory of a pending erasure request (what would be removed or retained).
  let {
    piiInventory,
    data,
  }: {
    piiInventory: PiiInventory | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.users-erasure-detail.inventory -->
<RegionFragment>
  <h2 class="text-lg font-semibold text-slate-950">PII Inventory</h2>
  <p class="mt-1 text-sm text-slate-600">
    This is the scope of what will be removed or retained — nothing has been touched yet.
  </p>

  {#if piiInventory}
    <div class="mt-4 overflow-hidden rounded-xl border border-slate-200">
      <table class="min-w-full text-left text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
          <tr>
            <th class="px-4 py-2 font-semibold">Table</th>
            <th class="px-4 py-2 font-semibold">Rows</th>
            <th class="px-4 py-2 font-semibold">PII fields</th>
          </tr>
        </thead>
        <tbody>
          {#each piiInventory.tables as row (row.table)}
            <tr class="border-b border-slate-100 last:border-b-0">
              <td class="px-4 py-2 font-medium text-slate-900">{row.table}</td>
              <td class="px-4 py-2 text-slate-600">{row.rowCount}</td>
              <td class="px-4 py-2 text-slate-600">{row.piiFields.join(', ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}<InjectionPoint name="settings.users-erasure-detail.inventory" {data} />
</RegionFragment>
