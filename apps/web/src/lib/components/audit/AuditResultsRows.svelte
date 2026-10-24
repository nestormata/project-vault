<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import type { AuditEventItem } from '$lib/api/audit.js'
  import AuditResultsRow from './AuditResultsRow.svelte'

  // Story 69.12: the event table. This component owns which row is expanded (one at a time), so the
  // rows and their detail rows stay one sequence in the table body; the point closes after the table.
  let {
    events,
    pointProps,
    data,
  }: {
    events: readonly AuditEventItem[]
    pointProps: InjectionPointExtras<'settings.audit.results'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  let expandedRowId = $state<string | null>(null)

  function toggleRow(id: string) {
    expandedRowId = expandedRowId === id ? null : id
  }
</script>

<!-- @region settings.audit.results-rows -->
<RegionFragment>
  <DataTable columns={['Event type', 'Actor', 'Resource', 'Project', 'IP address', 'Created at']}>
    {#each events as event (event.id)}
      <AuditResultsRow
        {event}
        expanded={expandedRowId === event.id}
        onToggle={() => toggleRow(event.id)}
        {pointProps}
        {data}
      />
    {/each}
  </DataTable><InjectionPoint name="settings.audit.results-rows" props={pointProps} {data} />
</RegionFragment>
