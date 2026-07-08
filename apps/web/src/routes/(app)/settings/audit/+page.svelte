<script lang="ts">
  import { resolve } from '$app/paths'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import AuditExportPanel from '$lib/components/audit/AuditExportPanel.svelte'
  import AuditVerifyPanel from '$lib/components/audit/AuditVerifyPanel.svelte'

  let { data } = $props()

  const hasFilters = $derived(
    data.allowed && data.filters && Object.values(data.filters).some((value) => Boolean(value))
  )

  let expandedRowId = $state<string | null>(null)

  function toggleRow(id: string) {
    expandedRowId = expandedRowId === id ? null : id
  }

  function filterSummary(filters: Record<string, string | undefined>): string {
    const parts: string[] = []
    if (filters.eventType) parts.push(`event type = ${filters.eventType}`)
    if (filters.actorId) parts.push(`actor = ${filters.actorId}`)
    if (filters.resourceId) parts.push(`resource = ${filters.resourceId}`)
    if (filters.projectId) parts.push(`project = ${filters.projectId}`)
    if (filters.from || filters.to) {
      parts.push(`${(filters.from ?? '…').slice(0, 10)} → ${(filters.to ?? '…').slice(0, 10)}`)
    }
    return parts.join(', ')
  }
</script>

<svelte:head>
  <title>Audit Log | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Audit &amp; Compliance</h1>
  <p class="mt-2 text-gray-500">Search, export, and verify your organization's audit log.</p>

  {#if !data.allowed}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This page requires the owner role.</p>
      <a href={resolve('/settings')} class="mt-2 inline-block text-sm text-indigo-600 underline">
        ← Back to Settings
      </a>
      {#if data.orgRole === 'admin'}
        <p class="mt-4 text-sm text-slate-600">
          You can still access
          <a
            href={resolve('/settings/audit/forwarding')}
            class="font-medium text-indigo-600 underline"
          >
            Forwarding & Retention →
          </a>
        </p>
      {/if}
    </div>
  {:else}
    <div class="mt-6 flex flex-wrap gap-4 text-sm">
      <a
        href={resolve('/settings/audit/access-report')}
        class="font-medium text-indigo-600 underline"
      >
        Access Report →
      </a>
      <a href={resolve('/settings/audit/forwarding')} class="font-medium text-indigo-600 underline">
        Forwarding & Retention →
      </a>
    </div>

    {#if data.errorMessage}
      <p
        class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        role="alert"
      >
        {data.errorMessage}
      </p>
    {/if}

    <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Search</h2>
      <form method="GET" class="mt-4 flex flex-wrap items-end gap-3">
        <label class="flex flex-col text-sm text-slate-700" for="filter-eventType">
          Event type
          <input
            id="filter-eventType"
            name="eventType"
            type="text"
            class="rounded-lg border border-slate-300 px-2 py-1"
            value={data.filters?.eventType ?? ''}
          />
        </label>
        <label class="flex flex-col text-sm text-slate-700" for="filter-actorId">
          Actor ID
          <input
            id="filter-actorId"
            name="actorId"
            type="text"
            class="rounded-lg border border-slate-300 px-2 py-1"
            value={data.filters?.actorId ?? ''}
          />
        </label>
        <label class="flex flex-col text-sm text-slate-700" for="filter-resourceId">
          Resource ID
          <input
            id="filter-resourceId"
            name="resourceId"
            type="text"
            class="rounded-lg border border-slate-300 px-2 py-1"
            value={data.filters?.resourceId ?? ''}
          />
        </label>
        <label class="flex flex-col text-sm text-slate-700" for="filter-projectId">
          Project ID
          <input
            id="filter-projectId"
            name="projectId"
            type="text"
            class="rounded-lg border border-slate-300 px-2 py-1"
            value={data.filters?.projectId ?? ''}
          />
        </label>
        <label class="flex flex-col text-sm text-slate-700" for="filter-from">
          From
          <input
            id="filter-from"
            name="from"
            type="text"
            placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
            class="rounded-lg border border-slate-300 px-2 py-1"
            value={data.filters?.from ?? ''}
          />
        </label>
        <label class="flex flex-col text-sm text-slate-700" for="filter-to">
          To
          <input
            id="filter-to"
            name="to"
            type="text"
            placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
            class="rounded-lg border border-slate-300 px-2 py-1"
            value={data.filters?.to ?? ''}
          />
        </label>
        <button
          type="submit"
          class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
        >
          Search
        </button>
      </form>

      {#if hasFilters}
        <p class="mt-4 text-sm text-slate-600">
          Filtered by: {filterSummary(data.filters ?? {})}
          <a href={resolve('/settings/audit')} class="ml-2 text-indigo-600 underline">
            Clear filters
          </a>
        </p>
      {/if}

      <div class="mt-4">
        {#if data.events.length === 0}
          <p class="py-6 text-center text-slate-600">
            {hasFilters ? 'No audit events match these filters.' : 'No audit events yet.'}
          </p>
        {:else}
          <DataTable
            columns={['Event type', 'Actor', 'Resource', 'Project', 'IP address', 'Created at']}
          >
            {#each data.events as event (event.id)}
              <tr
                class="cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                onclick={() => toggleRow(event.id)}
              >
                <td class="px-4 py-3 font-medium text-slate-900">{event.eventType}</td>
                <td class="px-4 py-3 text-slate-600">{event.actorDisplayName}</td>
                <td class="px-4 py-3 text-slate-600">{event.resourceType ?? '—'}</td>
                <td class="px-4 py-3 text-slate-600">{event.projectId ?? '—'}</td>
                <td class="px-4 py-3 text-slate-600">{event.ipAddress ?? '—'}</td>
                <td class="px-4 py-3 text-slate-600"
                  >{new Date(event.createdAt).toLocaleString()}</td
                >
              </tr>
              {#if expandedRowId === event.id}
                <tr class="border-b border-slate-100 bg-slate-50 last:border-b-0">
                  <td colspan="6" class="px-4 py-3 text-sm text-slate-700">
                    <dl class="grid grid-cols-2 gap-2">
                      <dt class="font-medium">Resource ID</dt>
                      <dd>{event.resourceId ?? '—'}</dd>
                      <dt class="font-medium">Resource type</dt>
                      <dd>{event.resourceType ?? '—'}</dd>
                      <dt class="font-medium">Project</dt>
                      <dd>{event.projectId ?? '—'}</dd>
                      <dt class="font-medium">IP address</dt>
                      <dd>{event.ipAddress ?? '—'}</dd>
                      <dt class="font-medium">Actor</dt>
                      <dd>{event.actorDisplayName}</dd>
                      <dt class="font-medium">Created at</dt>
                      <dd>{event.createdAt}</dd>
                    </dl>
                  </td>
                </tr>
              {/if}
            {/each}
          </DataTable>

          <p class="mt-3 text-sm text-slate-500">
            {data.total} total event{data.total === 1 ? '' : 's'} — page {data.page}
          </p>
        {/if}
      </div>
    </div>

    <div class="mt-6">
      <AuditExportPanel />
    </div>
    <div class="mt-6">
      <AuditVerifyPanel />
    </div>
  {/if}
</div>
