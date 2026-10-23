<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import CredentialsListRow from './CredentialsListRow.svelte'
  import type { CredentialListFilters } from './credentials-list-href.js'

  // Story 69.10: the results of the credentials list (the empty state, or the table with the count)
  // as one replaceable region. The empty-state wording depends on the active filters and on whether
  // the caller can create secrets.
  let {
    projectId,
    filters,
    items,
    total,
    canCreate,
    data,
  }: {
    projectId: string
    filters: CredentialListFilters
    items: readonly ComponentProps<typeof CredentialsListRow>['credential'][]
    total: number
    canCreate: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials.results -->
<RegionFragment>
  {#if items.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <h2 class="text-xl font-semibold text-slate-950">No secrets found</h2>
      <p class="mt-2 text-slate-600">
        {#if filters.q || filters.status || filters.tags}
          Try adjusting your filters.
        {:else if canCreate}
          Add your first secret to get started.
        {:else}
          No secrets have been added to this project yet.
        {/if}
      </p>
    </div>
  {:else}
    <DataTable columns={['Name', 'Status', 'Rotation', 'Tags', 'Expires', 'Deps']}>
      {#each items as credential (credential.id)}
        <CredentialsListRow {credential} {projectId} />
      {/each}
    </DataTable>

    <p class="text-sm text-slate-600">
      Showing {items.length} of {total} secrets
    </p>
  {/if}<InjectionPoint name="project.credentials.results" {data} />
</RegionFragment>
