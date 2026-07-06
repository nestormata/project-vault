<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteServiceEndpoint } from '$lib/api/service-endpoints.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import ServiceStatusItem from '$lib/components/dashboard/ServiceStatusItem.svelte'
  import {
    ActiveAlertsPanel,
    AssetListHeader,
    AssetRowActions,
    EmptyAssetState,
    FormErrorBanner,
    ProjectNotFoundBanner,
  } from '$lib/components/monitoring/index.js'
  import { canManageMonitoredAssets } from '$lib/monitoring/index.js'

  let { data } = $props()

  // A writable $derived — see services/+page.svelte for why: resets to `data.endpoints` on every
  // navigation to this route shape, while remaining locally reassignable for the optimistic-delete
  // row removal below.
  let endpoints = $derived<ServiceEndpointDetail[]>(data.endpoints)
  let deleteError = $state<string | null>(null)

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
</script>

<svelte:head>
  <title>Service endpoints | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <AssetListHeader
    eyebrow="Endpoints"
    title="HTTP endpoint monitors"
    addHref={`/projects/${data.projectId}/service-endpoints/new`}
    addLabel="Add endpoint"
    {canManage}
  >
    Endpoints checked on a schedule; status feeds the org-wide health dashboard and public status
    page.
  </AssetListHeader>

  {#if data.notFound}
    <ProjectNotFoundBanner />
  {:else}
    <ActiveAlertsPanel
      alerts={data.alerts}
      endpoints={endpointNames}
      orgRole={data.orgRole}
      projectId={data.projectId}
    />

    {#if endpoints.length === 0}
      <EmptyAssetState message="No service endpoints registered yet." />
    {:else}
      <FormErrorBanner message={deleteError} />
      <ul class="space-y-3">
        {#each endpoints as endpoint (endpoint.id)}
          <li
            class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <ServiceStatusItem
              name={endpoint.name}
              status={endpoint.status}
              lastCheckedAt={endpoint.lastCheckedAt}
            />
            <div class="text-sm text-slate-600">
              <p>Checked every {endpoint.checkFrequencyMinutes} min</p>
              <p>Down after {endpoint.downThresholdFailures} consecutive failures</p>
            </div>
            {#if canManage}
              <AssetRowActions
                editHref={`/projects/${data.projectId}/service-endpoints/${endpoint.id}`}
                confirmLabel="Confirm delete? This will also resolve any active alerts for it."
                onDelete={() => handleDelete(endpoint.id)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
