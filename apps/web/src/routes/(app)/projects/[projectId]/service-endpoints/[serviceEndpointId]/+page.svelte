<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteServiceEndpoint, updateServiceEndpoint } from '$lib/api/service-endpoints.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import BackLink from '$lib/components/monitoring/BackLink.svelte'
  import ServiceEndpointDelete from '$lib/components/monitoring/ServiceEndpointDelete.svelte'
  import ServiceEndpointDetailNotFound from '$lib/components/monitoring/ServiceEndpointDetailNotFound.svelte'
  import ServiceEndpointHistory from '$lib/components/monitoring/ServiceEndpointHistory.svelte'
  import ServiceEndpointPause from '$lib/components/monitoring/ServiceEndpointPause.svelte'
  import ServiceEndpointSettings from '$lib/components/monitoring/ServiceEndpointSettings.svelte'
  import ServiceEndpointTitle from '$lib/components/monitoring/ServiceEndpointTitle.svelte'
  import { canManageMonitoredAssets, mapMonitoringSubmitError } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  let deleteError = $state<string | null>(null)
  let pauseSubmitting = $state(false)
  let pauseError = $state<string | null>(null)

  async function handlePauseToggle(paused: boolean): Promise<boolean> {
    if (!data.endpoint || pauseSubmitting || !canManage) return false
    pauseSubmitting = true
    pauseError = null
    try {
      const updated = await updateServiceEndpoint(fetch, data.projectId, data.endpoint.id, {
        healthCheckPaused: paused,
      })
      data = { ...data, endpoint: updated }
      return true
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        data = { ...data, endpoint: null, notFound: true }
        return false
      }
      pauseError = mapMonitoringSubmitError(
        error,
        'You do not have permission to change monitoring state.'
      ).errorMessage
      return false
    } finally {
      pauseSubmitting = false
    }
  }

  function handleUpdated(updated: ServiceEndpointDetail) {
    if (!data.endpoint) return
    data = { ...data, endpoint: updated }
  }

  async function handleDelete() {
    if (!data.endpoint) return
    deleteError = null
    try {
      await deleteServiceEndpoint(fetch, data.projectId, data.endpoint.id)
      await goto(resolve(`/projects/${data.projectId}/service-endpoints`))
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete endpoint.'
    }
  }
</script>

<svelte:head>
  <title>{data.endpoint?.name ?? 'Endpoint'} | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.service-endpoints-detail.before" data={data?.__inject} />
<InjectionPoint name="project.service-endpoints-detail.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  {#if data.notFound || !data.endpoint}
    <ServiceEndpointDetailNotFound
      project={data.project}
      projectId={data.projectId}
      data={data.__inject}
    />
  {:else}
    {@const endpoint = data.endpoint}
    <ServiceEndpointTitle
      project={data.project}
      {endpoint}
      orgRole={data.orgRole}
      data={data.__inject}
    />

    {#if endpoint.healthCheckPaused === true || endpoint.healthCheckPaused === false}
      <ServiceEndpointPause
        project={data.project}
        {endpoint}
        orgRole={data.orgRole}
        paused={endpoint.healthCheckPaused}
        {canManage}
        submitting={pauseSubmitting}
        errorMessage={pauseError}
        onToggle={handlePauseToggle}
        data={data.__inject}
      />
    {/if}

    <ServiceEndpointSettings
      project={data.project}
      {endpoint}
      orgRole={data.orgRole}
      projectId={data.projectId}
      onUpdated={handleUpdated}
      data={data.__inject}
    />

    {#if canManage}
      <ServiceEndpointDelete
        project={data.project}
        {endpoint}
        orgRole={data.orgRole}
        {deleteError}
        onDelete={handleDelete}
        data={data.__inject}
      />
    {/if}

    <ServiceEndpointHistory
      project={data.project}
      {endpoint}
      orgRole={data.orgRole}
      projectId={data.projectId}
      data={data.__inject}
    />

    <BackLink node="back.project.service-endpoint" projectId={data.projectId} />
  {/if}
</section>
<InjectionPoint name="project.service-endpoints-detail.after" data={data?.__inject} />
