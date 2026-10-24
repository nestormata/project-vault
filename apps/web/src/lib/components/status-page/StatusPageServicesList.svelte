<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'
  import StatusPageServiceRow from './StatusPageServiceRow.svelte'
  import type { ServiceRow, ServiceRowCallbacks } from './service-row.js'

  // Story 69.11: the selectable services of the status page admin card (check to publish, rename,
  // reorder). The page keeps the selection state; this region renders the merged rows and hands every
  // change back through its callbacks.
  let {
    project,
    capabilities,
    serviceEndpoints,
    rows,
    selectedCount,
    isBusy,
    onToggle,
    onSetDisplayName,
    onMove,
    data,
  }: ServiceRowCallbacks & {
    project: StatusPageAdminPointProps['project']
    capabilities: StatusPageAdminPointProps['capabilities']
    serviceEndpoints: StatusPageAdminPointProps['serviceEndpoints']
    data?: Record<string, readonly unknown[]> | undefined
    rows: ServiceRow[]
    selectedCount: number
    isBusy: boolean
  } = $props()
</script>

<!-- @region project.status-page.services-list -->
<RegionFragment>
  <p class="text-sm text-slate-600">
    Check a service to publish it and edit its public display name. Selected services are listed
    first, in the order they'll appear — use the keyboard-operable move buttons to reorder them when
    more than one is selected.
  </p>
  <ol aria-label="Services shown on the public page" class="space-y-3">
    {#each rows as row (row.id)}
      <StatusPageServiceRow {row} {selectedCount} {isBusy} {onToggle} {onSetDisplayName} {onMove} />
    {/each}
  </ol>
  <InjectionPoint
    name="project.status-page.services-list"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</RegionFragment>
