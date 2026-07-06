<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteCertificate } from '$lib/api/certificates.js'
  import type { CertificateRecord } from '$lib/api/certificates.js'
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

  let certificates = $derived<CertificateRecord[]>(data.certificates)
  let deleteError = $state<string | null>(null)

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  async function handleDelete(certificateId: string) {
    deleteError = null
    try {
      await deleteCertificate(fetch, data.projectId, certificateId)
      certificates = certificates.filter((c) => c.id !== certificateId)
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        certificates = certificates.filter((c) => c.id !== certificateId)
      }
      deleteError = error instanceof Error ? error.message : 'Could not delete certificate.'
    }
  }
</script>

<svelte:head>
  <title>Certificates | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <AssetListHeader
    eyebrow="Certificates"
    title="SSL/TLS certificates"
    addHref={`/projects/${data.projectId}/certificates/new`}
    addLabel="Add certificate"
    {canManage}
  >
    Certificates tracked for expiry alerting.
  </AssetListHeader>

  {#if data.notFound}
    <ProjectNotFoundBanner />
  {:else if certificates.length === 0}
    <EmptyAssetState message="No certificates registered yet." />
  {:else}
    <FormErrorBanner message={deleteError} />
    <AssetTable columns={['Domain', 'Expires on', 'Alert lead days']} {canManage}>
      {#each certificates as certificate (certificate.id)}
        <tr class="border-b border-slate-100 last:border-b-0">
          <td class="px-4 py-3 font-semibold text-slate-950">{certificate.domain}</td>
          <td class="px-4 py-3 text-slate-600">{formatDate(certificate.expiresAt)}</td>
          <td class="px-4 py-3 text-slate-600">
            {formatAlertLeadDays(certificate.alertLeadDays)}
          </td>
          {#if canManage}
            <td class="px-4 py-3">
              <AssetRowActions
                editHref={`/projects/${data.projectId}/certificates/${certificate.id}`}
                onDelete={() => handleDelete(certificate.id)}
              />
            </td>
          {/if}
        </tr>
      {/each}
    </AssetTable>
  {/if}
</section>
