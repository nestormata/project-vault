<script lang="ts">
  import { resolve } from '$app/paths'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import ProjectsListCell from '$lib/components/tables/ProjectsListCell.svelte'
  import { runAccessReportCsv } from '$lib/api/audit.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { triggerTextDownload } from '$lib/download.js'

  let { data } = $props()

  let downloadError = $state<string | null>(null)
  let downloading = $state(false)

  function toDateInputValue(value: string | undefined): string {
    return value ? value.slice(0, 10) : ''
  }

  // AC-G3 — the filename is constructed client-side since the server supplies no
  // Content-Disposition header for this endpoint.
  async function onDownloadCsv() {
    if (!data.allowed || downloading) return
    downloading = true
    downloadError = null
    try {
      const csv = await runAccessReportCsv(fetch, {
        asOf: data.asOf,
        page: data.page ?? 1,
        limit: 20,
      })
      const suffix = data.asOf ? data.asOf.slice(0, 10) : 'current'
      triggerTextDownload(`access-report-${suffix}.csv`, 'text/csv', csv)
    } catch (err) {
      downloadError =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to download CSV')
          : 'Failed to download CSV'
    } finally {
      downloading = false
    }
  }
</script>

<svelte:head>
  <title>Access Report | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Access Report</h1>
  <p class="mt-2 text-gray-500">Who had access, as of any point in time.</p>
  <a href={resolve('/settings/audit')} class="mt-2 inline-block text-sm text-indigo-600 underline">
    ← Back to Audit Log
  </a>

  {#if !data.allowed}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This page requires the owner role.</p>
    </div>
  {:else}
    <form method="GET" class="mt-6 flex flex-wrap items-end gap-3">
      <label class="flex flex-col text-sm text-slate-700" for="asOf">
        As of (leave blank for current state)
        <input
          id="asOf"
          name="asOf"
          type="date"
          class="rounded-lg border border-slate-300 px-2 py-1"
          value={toDateInputValue(data.asOf)}
        />
      </label>
      <button
        type="submit"
        class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
      >
        Generate report
      </button>
    </form>

    {#if data.errorMessage}
      <p
        class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        role="alert"
      >
        {data.errorMessage}
      </p>
    {/if}

    {#if data.report}
      <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm text-slate-600">
            As of: <strong>{data.report.asOf.slice(0, 10)}</strong>
            — generated at {new Date(data.report.generatedAt).toLocaleString()}
          </p>
          <button
            type="button"
            class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
            disabled={downloading}
            onclick={() => void onDownloadCsv()}
          >
            {downloading ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
        {#if downloadError}
          <p class="mt-2 text-sm text-red-700" role="alert">{downloadError}</p>
        {/if}

        {#if data.report.users.length === 0}
          <p class="mt-4 py-6 text-center text-slate-600">No users found for this report.</p>
        {:else}
          <div class="mt-4">
            <DataTable columns={['User', 'Org role', 'Status', 'Projects']}>
              {#each data.report.users as user (user.userId)}
                <tr class="border-b border-slate-100 align-top last:border-b-0">
                  <td class="px-4 py-3 font-medium text-slate-900">{user.displayName}</td>
                  <td class="px-4 py-3 text-slate-600">{user.orgRole}</td>
                  <td class="px-4 py-3">
                    {#if user.status === 'deactivated'}
                      <span class="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700">
                        Deactivated
                      </span>
                    {:else}
                      <span
                        class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800"
                      >
                        Active
                      </span>
                    {/if}
                  </td>
                  <td class="px-4 py-3">
                    <ProjectsListCell projects={user.projects}>
                      {#each user.projects as project (project.projectId)}
                        <li class="text-slate-700">{project.projectName}: {project.role}</li>
                      {/each}
                    </ProjectsListCell>
                  </td>
                </tr>
              {/each}
            </DataTable>
          </div>

          <div class="mt-4 flex justify-center gap-2">
            {#if (data.page ?? 1) > 1}
              <!-- eslint-disable svelte/no-navigation-without-resolve -- dynamic query string, not a literal resolve() can type-check (`-next-line` doesn't reach `href` on a multi-line tag) -->
              <a
                href="?{data.asOf ? `asOf=${data.asOf}&` : ''}page={(data.page ?? 1) - 1}"
                class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Previous
              </a>
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {/if}
            {#if data.report.hasNext}
              <!-- eslint-disable svelte/no-navigation-without-resolve -- dynamic query string, not a literal resolve() can type-check (`-next-line` doesn't reach `href` on a multi-line tag) -->
              <a
                href="?{data.asOf ? `asOf=${data.asOf}&` : ''}page={(data.page ?? 1) + 1}"
                class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Next
              </a>
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
