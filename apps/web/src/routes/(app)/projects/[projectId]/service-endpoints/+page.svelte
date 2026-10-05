<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteServiceEndpoint, updateServiceEndpoint } from '$lib/api/service-endpoints.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import ServiceEndpointsAlerts from '$lib/components/monitoring/ServiceEndpointsAlerts.svelte'
  import ServiceEndpointsEmpty from '$lib/components/monitoring/ServiceEndpointsEmpty.svelte'
  import ServiceEndpointsHeader from '$lib/components/monitoring/ServiceEndpointsHeader.svelte'
  import ServiceEndpointsNotFound from '$lib/components/monitoring/ServiceEndpointsNotFound.svelte'
  import ServiceEndpointsTable from '$lib/components/monitoring/ServiceEndpointsTable.svelte'
  import { canManageMonitoredAssets, mapMonitoringSubmitError } from '$lib/monitoring/index.js'

  let { data } = $props()

  // A writable $derived — see services/+page.svelte for why: resets to `data.endpoints` on every
  // navigation to this route shape, while remaining locally reassignable for the optimistic-delete
  // row removal below.
  let endpoints = $derived<ServiceEndpointDetail[]>(data.endpoints)
  let deleteError = $state<string | null>(null)
  let pauseSubmittingId = $state<string | null>(null)
  let pauseErrors = $state<Record<string, string>>({})

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))
  const endpointNames = $derived(endpoints.map((e) => ({ id: e.id, name: e.name })))

  async function handleDelete(serviceEndpointId: string) {
    deleteError = null
    try {
      await deleteServiceEndpoint(fetch, data.projectId, serviceEndpointId)
      endpoints = endpoints.filter((e) => e.id !== serviceEndpointId)
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        endpoints = endpoints.filter((e) => e.id !== serviceEndpointId)
      }
      deleteError = error instanceof Error ? error.message : 'Could not delete endpoint.'
    }
  }

  async function handlePauseToggle(serviceEndpointId: string, paused: boolean): Promise<boolean> {
    const endpoint = endpoints.find((item) => item.id === serviceEndpointId)
    if (!endpoint || pauseSubmittingId) return false
    pauseSubmittingId = serviceEndpointId
    pauseErrors = { ...pauseErrors, [serviceEndpointId]: '' }
    try {
      const updated = await updateServiceEndpoint(fetch, data.projectId, serviceEndpointId, {
        healthCheckPaused: paused,
      })
      endpoints = endpoints.map((item) => (item.id === serviceEndpointId ? updated : item))
      return true
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to change monitoring state.'
      )
      pauseErrors = { ...pauseErrors, [serviceEndpointId]: mapped.errorMessage }
      return false
    } finally {
      pauseSubmittingId = null
    }
  }
</script>

<svelte:head>
  <title>Service endpoints | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.service-endpoints.before" data={data?.__inject} />
<InjectionPoint name="project.service-endpoints.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <ServiceEndpointsHeader
    project={data.project}
    orgRole={data.orgRole}
    {endpoints}
    projectId={data.projectId}
    {canManage}
    data={data.__inject}
  />

  {#if data.notFound}
    <ServiceEndpointsNotFound
      project={data.project}
      orgRole={data.orgRole}
      {endpoints}
      data={data.__inject}
    />
  {:else}
    <ServiceEndpointsAlerts
      project={data.project}
      orgRole={data.orgRole}
      {endpoints}
      alerts={data.alerts}
      {endpointNames}
      projectId={data.projectId}
      data={data.__inject}
    />

    {#if endpoints.length === 0}
      <ServiceEndpointsEmpty
        project={data.project}
        orgRole={data.orgRole}
        {endpoints}
        data={data.__inject}
      />
    {:else}
      <ServiceEndpointsTable
        project={data.project}
        {endpoints}
        orgRole={data.orgRole}
        projectId={data.projectId}
        {canManage}
        {deleteError}
        {pauseSubmittingId}
        {pauseErrors}
        onDelete={handleDelete}
        onPauseToggle={handlePauseToggle}
        data={data.__inject}
      />
    {/if}
  {/if}
</section>
<InjectionPoint name="project.service-endpoints.after" data={data?.__inject} />
