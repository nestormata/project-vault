<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteService } from '$lib/api/services.js'
  import type { PaymentRecord } from '$lib/api/services.js'
  import {
    AssetListHeader,
    AssetRowActions,
    AssetTable,
    EmptyAssetState,
    FormErrorBanner,
    ProjectNotFoundBanner,
  } from '$lib/components/monitoring/index.js'
  import {
    canManageMonitoredAssets,
    formatAlertLeadDays,
    formatDate,
  } from '$lib/monitoring/index.js'

  let { data } = $props()

  // A writable $derived: resets to `data.services` whenever `data` changes (new load/navigation —
  // SvelteKit reuses this component instance across navigations to the same route shape, so a
  // plain $state initializer would otherwise only capture the first-mounted value and go stale on
  // a subsequent navigation, per the adversarial review's dynamic-route component-reuse finding),
  // while still being locally reassignable for the optimistic-delete row removal below.
  let services = $derived<PaymentRecord[]>(data.services)
  let deleteError = $state<string | null>(null)

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  async function handleDelete(serviceId: string) {
    deleteError = null
    try {
      await deleteService(fetch, data.projectId, serviceId)
      services = services.filter((s) => s.id !== serviceId)
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        // AC-B5 failure: already deleted elsewhere — refresh the list, do not pretend success.
        services = services.filter((s) => s.id !== serviceId)
      }
      deleteError = error instanceof Error ? error.message : 'Could not delete service.'
    }
  }
</script>

<svelte:head>
  <title>Services | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <AssetListHeader
    eyebrow="Services"
    title="Monitored services"
    addHref={`/projects/${data.projectId}/services/new`}
    addLabel="Add service"
    {canManage}
  >
    Billing/hosting services tracked for renewal alerting.
  </AssetListHeader>

  {#if data.notFound}
    <ProjectNotFoundBanner />
  {:else if services.length === 0}
    <EmptyAssetState message="No services registered yet." />
  {:else}
    <FormErrorBanner message={deleteError} />
    <AssetTable columns={['Name', 'URL', 'Renewal date', 'Alert lead days']} {canManage}>
      {#each services as service (service.id)}
        <tr class="border-b border-slate-100 last:border-b-0">
          <td class="px-4 py-3 font-semibold text-slate-950">{service.name}</td>
          <td class="px-4 py-3 text-slate-600">{service.url ?? '—'}</td>
          <td class="px-4 py-3 text-slate-600">{formatDate(service.renewalDate)}</td>
          <td class="px-4 py-3 text-slate-600">{formatAlertLeadDays(service.alertLeadDays)}</td>
          {#if canManage}
            <td class="px-4 py-3">
              <AssetRowActions
                editHref={`/projects/${data.projectId}/services/${service.id}`}
                onDelete={() => handleDelete(service.id)}
              />
            </td>
          {/if}
        </tr>
      {/each}
    </AssetTable>
  {/if}
</section>
