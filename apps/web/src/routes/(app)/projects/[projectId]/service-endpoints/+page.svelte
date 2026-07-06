<script lang="ts">
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteServiceEndpoint } from '$lib/api/service-endpoints.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import ServiceStatusItem from '$lib/components/dashboard/ServiceStatusItem.svelte'
  import ActiveAlertsPanel from '$lib/components/monitoring/ActiveAlertsPanel.svelte'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'

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
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Endpoints</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">HTTP endpoint monitors</h1>
      <p class="mt-2 text-slate-600">
        Endpoints checked on a schedule; status feeds the org-wide health dashboard and public
        status page.
      </p>
    </div>
    {#if canManage}
      <a
        class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
        href={resolve(`/projects/${data.projectId}/service-endpoints/new`)}
      >
        Add endpoint
      </a>
    {/if}
  </div>

  {#if data.notFound}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <p class="text-red-800">This project was not found or you do not have access.</p>
    </div>
  {:else}
    <ActiveAlertsPanel
      alerts={data.alerts}
      endpoints={endpointNames}
      orgRole={data.orgRole}
      projectId={data.projectId}
    />

    {#if endpoints.length === 0}
      <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
        <p class="text-slate-600">No service endpoints registered yet.</p>
      </div>
    {:else}
      {#if deleteError}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {deleteError}
        </p>
      {/if}
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
              <div class="flex items-center gap-2">
                <a
                  class="font-medium text-slate-700 underline"
                  href={resolve(`/projects/${data.projectId}/service-endpoints/${endpoint.id}`)}
                >
                  Edit
                </a>
                <ConfirmDeleteButton
                  confirmLabel="Confirm delete? This will also resolve any active alerts for it."
                  onConfirm={() => handleDelete(endpoint.id)}
                />
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
