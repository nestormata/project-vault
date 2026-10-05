<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/service-endpoints/$types.js'
  import type { Snippet } from 'svelte'
  import { mapMonitoringSubmitError } from '$lib/monitoring/index.js'
  import { deleteServiceEndpoint, updateServiceEndpoint } from '$lib/api/service-endpoints.js'
  import { ApiClientError } from '$lib/api/client.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import {
    ActiveAlertsPanel,
    AssetRowActions,
    AssetTable,
    EmptyAssetState,
    FormErrorBanner,
    MonitoringPauseControl,
    ProjectNotFoundBanner,
  } from '$lib/components/monitoring/index.js'
  import { formatCheckedAt, statusClass } from '$lib/components/dashboard/service-status.js'

  let { data, canManage, children }: { data: PageData; canManage: boolean; children?: Snippet } =
    $props()

  // A writable $derived — see services/+page.svelte for why: resets to `data.endpoints` on every
  // navigation to this route shape, while remaining locally reassignable for the optimistic-delete
  // row removal below.
  let endpoints = $derived<ServiceEndpointDetail[]>(data.endpoints)
  let deleteError = $state<string | null>(null)
  let pauseSubmittingId = $state<string | null>(null)
  let pauseErrors = $state<Record<string, string>>({})
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

{@render children?.()}
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
    <AssetTable
      caption="Service endpoints monitored in this project"
      columns={[{ label: 'Endpoint', headerClass: 'w-1/3' }, 'Status', 'Schedule', 'Monitoring']}
      {canManage}
    >
      {#each endpoints as endpoint (endpoint.id)}
        <!-- The amber tint restores the at-a-glance paused signal the old per-row card carried;
             the "Monitoring paused" text in the cell is what actually conveys it. -->
        <tr
          class={`border-b border-slate-100 last:border-b-0 ${endpoint.healthCheckPaused ? 'bg-amber-50' : ''}`.trim()}
        >
          <td class="px-4 py-3 font-semibold text-slate-950">
            <!-- `truncate` needs a bounded box; an auto-width <td> would just grow instead. -->
            <div class="max-w-[14rem] sm:max-w-[20rem]">
              <p class="truncate" title={endpoint.name}>{endpoint.name}</p>
              <p class="truncate text-xs font-normal text-slate-500" title={endpoint.url}>
                {endpoint.url}
              </p>
              <p class="text-xs font-normal text-slate-500">
                {formatCheckedAt(endpoint.lastCheckedAt)}
              </p>
            </div>
          </td>
          <td class="px-4 py-3 text-slate-600">
            <span
              class={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${statusClass(endpoint.status)}`}
            >
              {endpoint.status}
            </span>
          </td>
          <td class="px-4 py-3 text-slate-600">
            <p>Checked every {endpoint.checkFrequencyMinutes} min</p>
            <p>Down after {endpoint.downThresholdFailures} consecutive failures</p>
          </td>
          <!-- Bounded like the Endpoint cell: a per-row pause error is a full sentence, and in an
               auto-layout table an unbounded cell would widen the Monitoring column for every
               row — re-introducing the content-driven misalignment this story removed. -->
          <td class="w-[15rem] max-w-[15rem] px-4 py-3 text-slate-600">
            {#if endpoint.healthCheckPaused === true || endpoint.healthCheckPaused === false}
              <MonitoringPauseControl
                paused={endpoint.healthCheckPaused}
                pausedAt={endpoint.healthCheckPausedAt ?? null}
                lastKnownStatus={endpoint.status}
                {canManage}
                idSuffix={endpoint.id}
                variant="row"
                submitting={pauseSubmittingId === endpoint.id}
                errorMessage={pauseErrors[endpoint.id] || null}
                onToggle={(paused) => handlePauseToggle(endpoint.id, paused)}
              />
            {/if}
          </td>
          {#if canManage}
            <td class="px-4 py-3">
              <AssetRowActions
                editHref={`/projects/${data.projectId}/service-endpoints/${endpoint.id}`}
                confirmLabel="Confirm delete? This will also resolve any active alerts for it."
                onDelete={() => handleDelete(endpoint.id)}
              />
            </td>
          {/if}
        </tr>
      {/each}
    </AssetTable>
  {/if}
{/if}
