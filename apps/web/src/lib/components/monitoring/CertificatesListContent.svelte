<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/certificates/$types.js'
  import type { Snippet } from 'svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteCertificate } from '$lib/api/certificates.js'
  import type { CertificateRecord } from '$lib/api/certificates.js'
  import AssetListBody from '$lib/components/monitoring/AssetListBody.svelte'
  import { AssetRowActions } from '$lib/components/monitoring/index.js'
  import { formatAlertLeadDays, formatDate } from '$lib/monitoring/index.js'

  let { data, canManage, children }: { data: PageData; canManage: boolean; children?: Snippet } =
    $props()

  let certificates = $derived<CertificateRecord[]>(data.certificates)
  let deleteError = $state<string | null>(null)
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

{@render children?.()}
<AssetListBody
  notFound={data.notFound}
  isEmpty={certificates.length === 0}
  emptyMessage="No certificates registered yet."
  {deleteError}
  caption="Certificates monitored in this project"
  columns={['Domain', 'Expires on', 'Alert lead days']}
  {canManage}
>
  {#snippet rows()}
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
  {/snippet}
</AssetListBody>
