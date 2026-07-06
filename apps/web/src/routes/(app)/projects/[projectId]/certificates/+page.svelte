<script lang="ts">
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteCertificate } from '$lib/api/certificates.js'
  import type { CertificateRecord } from '$lib/api/certificates.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'

  let { data } = $props()

  // A writable $derived — see services/+page.svelte for why: resets to `data.certificates` on
  // every navigation to this route shape, while remaining locally reassignable for the
  // optimistic-delete row removal below.
  let certificates = $derived<CertificateRecord[]>(data.certificates)
  let deleteError = $state<string | null>(null)

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  function formatDate(value: string | null): string {
    if (!value) return '—'
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  function formatAlertLeadDays(days: number[]): string {
    if (days.length === 0) return '—'
    return `Alerts at ${days.join(', ')} days before`
  }

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
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Certificates</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">SSL/TLS certificates</h1>
      <p class="mt-2 text-slate-600">Certificates tracked for expiry alerting.</p>
    </div>
    {#if canManage}
      <a
        class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
        href={resolve(`/projects/${data.projectId}/certificates/new`)}
      >
        Add certificate
      </a>
    {/if}
  </div>

  {#if data.notFound}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <p class="text-red-800">This project was not found or you do not have access.</p>
    </div>
  {:else if certificates.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <p class="text-slate-600">No certificates registered yet.</p>
    </div>
  {:else}
    {#if deleteError}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {deleteError}
      </p>
    {/if}
    <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table class="min-w-full text-left text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
          <tr>
            <th class="px-4 py-3 font-semibold">Domain</th>
            <th class="px-4 py-3 font-semibold">Expires on</th>
            <th class="px-4 py-3 font-semibold">Alert lead days</th>
            {#if canManage}
              <th class="px-4 py-3 font-semibold">Actions</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each certificates as certificate (certificate.id)}
            <tr class="border-b border-slate-100 last:border-b-0">
              <td class="px-4 py-3 font-semibold text-slate-950">{certificate.domain}</td>
              <td class="px-4 py-3 text-slate-600">{formatDate(certificate.expiresAt)}</td>
              <td class="px-4 py-3 text-slate-600">
                {formatAlertLeadDays(certificate.alertLeadDays)}
              </td>
              {#if canManage}
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <a
                      class="font-medium text-slate-700 underline"
                      href={resolve(`/projects/${data.projectId}/certificates/${certificate.id}`)}
                    >
                      Edit
                    </a>
                    <ConfirmDeleteButton onConfirm={() => handleDelete(certificate.id)} />
                  </div>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
