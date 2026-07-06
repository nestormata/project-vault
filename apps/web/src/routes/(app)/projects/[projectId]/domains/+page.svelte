<script lang="ts">
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { deleteDomain } from '$lib/api/domains.js'
  import type { DomainRecord } from '$lib/api/domains.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'

  let { data } = $props()

  // AC-D1 edge: duplicate domainName values within a project are valid (Story 6.1 AC 3) — no
  // client-side dedup/merge is applied to this list.
  // A writable $derived — see services/+page.svelte for why: resets to `data.domains` on every
  // navigation to this route shape, while remaining locally reassignable for the optimistic-delete
  // row removal below.
  let domains = $derived<DomainRecord[]>(data.domains)
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
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Domains</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">Domain registrations</h1>
      <p class="mt-2 text-slate-600">Domains tracked for renewal alerting.</p>
    </div>
    {#if canManage}
      <a
        class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
        href={resolve(`/projects/${data.projectId}/domains/new`)}
      >
        Add domain
      </a>
    {/if}
  </div>

  {#if data.notFound}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <p class="text-red-800">This project was not found or you do not have access.</p>
    </div>
  {:else if domains.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <p class="text-slate-600">No domains registered yet.</p>
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
            <th class="px-4 py-3 font-semibold">Domain name</th>
            <th class="px-4 py-3 font-semibold">Renewal date</th>
            <th class="px-4 py-3 font-semibold">Alert lead days</th>
            {#if canManage}
              <th class="px-4 py-3 font-semibold">Actions</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each domains as domain (domain.id)}
            <tr class="border-b border-slate-100 last:border-b-0">
              <td class="px-4 py-3 font-semibold text-slate-950">{domain.domainName}</td>
              <td class="px-4 py-3 text-slate-600">{formatDate(domain.renewalDate)}</td>
              <td class="px-4 py-3 text-slate-600">{formatAlertLeadDays(domain.alertLeadDays)}</td>
              {#if canManage}
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <a
                      class="font-medium text-slate-700 underline"
                      href={resolve(`/projects/${data.projectId}/domains/${domain.id}`)}
                    >
                      Edit
                    </a>
                    <ConfirmDeleteButton onConfirm={() => handleDelete(domain.id)} />
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
