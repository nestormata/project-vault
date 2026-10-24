<script lang="ts">
  import type { OrgListItem } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'

  // Story 69.11: the organizations of the instance (the empty notice, or the table) as one
  // replaceable region.
  let {
    orgs,
    pageError,
    data,
  }: {
    orgs: OrgListItem[]
    pageError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-orgs.list -->
<div class="mt-6">
  {#if orgs.length === 0 && !pageError}
    <p class="rounded-lg border border-gray-200 bg-white px-6 py-8 text-center text-gray-500">
      No organizations found.
    </p>
  {:else}
    <DataTable columns={['Name', 'Slug', 'Created', 'Members']}>
      {#each orgs as org (org.id)}
        <tr class="border-b border-slate-100 last:border-b-0">
          <td class="px-4 py-3 font-medium text-slate-900">{org.name}</td>
          <td class="px-4 py-3 font-mono text-xs text-slate-600">{org.slug}</td>
          <td class="px-4 py-3 text-sm text-slate-600"
            >{new Date(org.createdAt).toLocaleDateString()}</td
          >
          <td class="px-4 py-3 text-sm text-slate-600">{org.memberCount}</td>
        </tr>
      {/each}
    </DataTable>
  {/if}<InjectionPoint name="platform.settings-orgs.list" {data} />
</div>
