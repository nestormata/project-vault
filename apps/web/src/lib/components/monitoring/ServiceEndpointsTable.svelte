<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { ProjectPointProps } from '$lib/components/composition/injection-points.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import type { OrgRole } from '$lib/monitoring/permissions.js'
  import AssetTable from './AssetTable.svelte'
  import FormErrorBanner from './FormErrorBanner.svelte'
  import ServiceEndpointRow from './ServiceEndpointRow.svelte'

  // Story 69.3: the delete-error banner and the endpoints table as one replaceable region. The
  // list's state (the optimistic list, delete error, per-row pause state) stays on the page and
  // arrives as props and callbacks, so a delete that empties the list still swaps the page to its
  // empty region. A contribution at `project.service-endpoints.table` receives
  // `{ project, endpoints, orgRole }` and renders right after the table card (never inside
  // `<table>`).
  let {
    project,
    endpoints,
    orgRole,
    projectId,
    canManage,
    deleteError,
    pauseSubmittingId,
    pauseErrors,
    onDelete,
    onPauseToggle,
    data,
  }: {
    project: ProjectPointProps['project']
    endpoints: ServiceEndpointDetail[]
    orgRole: OrgRole
    projectId: string
    canManage: boolean
    deleteError: string | null
    pauseSubmittingId: string | null
    pauseErrors: Record<string, string>
    onDelete: (serviceEndpointId: string) => void | Promise<void>
    onPauseToggle: (serviceEndpointId: string, paused: boolean) => boolean | Promise<boolean>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<FormErrorBanner message={deleteError} />
<!-- @region project.service-endpoints.table -->
<RegionFragment>
  <AssetTable
    caption="Service endpoints monitored in this project"
    columns={[{ label: 'Endpoint', headerClass: 'w-1/3' }, 'Status', 'Schedule', 'Monitoring']}
    {canManage}
  >
    {#each endpoints as endpoint (endpoint.id)}
      <ServiceEndpointRow
        {project}
        {endpoint}
        {orgRole}
        {projectId}
        {canManage}
        pauseSubmitting={pauseSubmittingId === endpoint.id}
        pauseError={pauseErrors[endpoint.id] || null}
        onPauseToggle={(paused) => onPauseToggle(endpoint.id, paused)}
        onDelete={() => onDelete(endpoint.id)}
        {data}
      />
    {/each}
  </AssetTable><InjectionPoint
    name="project.service-endpoints.table"
    props={{ project, endpoints, orgRole }}
    {data}
  />
</RegionFragment>
