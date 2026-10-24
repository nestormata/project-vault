<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'
  import StatusPageServicesEmpty from './StatusPageServicesEmpty.svelte'
  import StatusPageServicesList from './StatusPageServicesList.svelte'
  import StatusPageServicesSave from './StatusPageServicesSave.svelte'
  import type { ServiceRow } from './service-row.js'

  // Story 69.3: the "Services shown on the public page" card as one replaceable region. It renders
  // only when the page is enabled and the caller can manage it, and the page keeps the selection
  // state (it is shared with disable and the save/reorder handlers) and passes rows and callbacks
  // down. A contribution at `project.status-page.services` receives `{ project, capabilities, serviceEndpoints }`
  // and renders inside the card, after the controls.
  // Story 69.11: the card holds three sub-regions (the selectable services, the no-endpoints notice,
  // the save row), each with its own point.
  let {
    project,
    capabilities,
    projectId,
    serviceEndpoints,
    rows,
    selectedCount,
    capabilityDenied,
    isBusy,
    onToggle,
    onSetDisplayName,
    onMove,
    onSave,
    data,
  }: {
    project: StatusPageAdminPointProps['project']
    capabilities: StatusPageAdminPointProps['capabilities']
    projectId: string
    serviceEndpoints: StatusPageAdminPointProps['serviceEndpoints']
    rows: ServiceRow[]
    selectedCount: number
    capabilityDenied: boolean
    isBusy: boolean
    onToggle: (service: { id: string; name: string }) => void
    onSetDisplayName: (serviceId: string, displayName: string) => void
    onMove: (index: number, direction: -1 | 1) => void | Promise<void>
    onSave: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.services -->
<div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-xl font-semibold text-slate-950">Services shown on the public page</h2>
  {#if rows.length > 0}
    <StatusPageServicesList
      {project}
      {capabilities}
      {serviceEndpoints}
      {rows}
      {selectedCount}
      {isBusy}
      {onToggle}
      {onSetDisplayName}
      {onMove}
      {data}
    />
  {/if}
  {#if serviceEndpoints.length === 0}
    <StatusPageServicesEmpty {project} {capabilities} {serviceEndpoints} {projectId} {data} />
  {/if}
  <StatusPageServicesSave
    {project}
    {capabilities}
    {serviceEndpoints}
    {capabilityDenied}
    {isBusy}
    {onSave}
    {data}
  /><InjectionPoint
    name="project.status-page.services"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</div>
