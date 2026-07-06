<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteDomain } from '$lib/api/domains.js'
  import type { DomainRecord } from '$lib/api/domains.js'
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

  // AC-D1 edge: duplicate domainName values within a project are valid (Story 6.1 AC 3) — no
  // client-side dedup/merge is applied to this list.
  // A writable $derived — see services/+page.svelte for why: resets to `data.domains` on every
  // navigation to this route shape, while remaining locally reassignable for the optimistic-delete
  // row removal below.
  let domains = $derived<DomainRecord[]>(data.domains)
  let deleteError = $state<string | null>(null)

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  async function handleDelete(domainId: string) {
    deleteError = null
    try {
      await deleteDomain(fetch, data.projectId, domainId)
      domains = domains.filter((d) => d.id !== domainId)
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        domains = domains.filter((d) => d.id !== domainId)
      }
      deleteError = error instanceof Error ? error.message : 'Could not delete domain.'
    }
  }
</script>

<svelte:head>
  <title>Domains | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <AssetListHeader
    eyebrow="Domains"
    title="Domain registrations"
    addHref={`/projects/${data.projectId}/domains/new`}
    addLabel="Add domain"
    {canManage}
  >
    Domains tracked for renewal alerting.
  </AssetListHeader>

  {#if data.notFound}
    <ProjectNotFoundBanner />
  {:else if domains.length === 0}
    <EmptyAssetState message="No domains registered yet." />
  {:else}
    <FormErrorBanner message={deleteError} />
    <AssetTable columns={['Domain name', 'Renewal date', 'Alert lead days']} {canManage}>
      {#each domains as domain (domain.id)}
        <tr class="border-b border-slate-100 last:border-b-0">
          <td class="px-4 py-3 font-semibold text-slate-950">{domain.domainName}</td>
          <td class="px-4 py-3 text-slate-600">{formatDate(domain.renewalDate)}</td>
          <td class="px-4 py-3 text-slate-600">{formatAlertLeadDays(domain.alertLeadDays)}</td>
          {#if canManage}
            <td class="px-4 py-3">
              <AssetRowActions
                editHref={`/projects/${data.projectId}/domains/${domain.id}`}
                onDelete={() => handleDelete(domain.id)}
              />
            </td>
          {/if}
        </tr>
      {/each}
    </AssetTable>
  {/if}
</section>
