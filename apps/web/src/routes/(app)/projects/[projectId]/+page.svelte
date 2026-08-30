<script lang="ts">
  import { downloadExportBlob, exportProject } from '$lib/api/project-export.js'
  import { ApiClientError } from '$lib/api/client.js'

  let { data } = $props()

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  // Story 28.9 D2 — the export key is shown exactly once, mirroring the credential-share
  // creation flow's "copy it now, it will not be shown again" reveal-once convention.
  let exporting = $state(false)
  let exportError = $state<string | null>(null)
  let revealedExportKey = $state<string | null>(null)
  let exportKeyAcknowledged = $state(false)

  async function onExportProject(projectId: string): Promise<void> {
    if (exporting) return
    exporting = true
    exportError = null
    try {
      const result = await exportProject(fetch, projectId)
      downloadExportBlob(result.blob, result.filename)
      revealedExportKey = result.exportKey
      exportKeyAcknowledged = false
    } catch (error) {
      exportError =
        error instanceof ApiClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Export failed.'
    } finally {
      exporting = false
    }
  }

  function dismissExportKey(): void {
    if (!exportKeyAcknowledged) return
    revealedExportKey = null
  }
</script>

<svelte:head>
  <title>{data.project ? `${data.project.name} | Project Vault` : 'Project | Project Vault'}</title>
</svelte:head>

{#if data.notFound || !data.project}
  <section class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
    <h1 class="text-xl font-semibold text-slate-950">Project not found</h1>
    <p class="mt-2 text-slate-600">This project doesn't exist, or you don't have access to it.</p>
  </section>
{:else}
  {@const project = data.project}
  {@const dashboard = data.dashboard}
  <section class="space-y-6">
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-3xl font-bold text-slate-950">{project.name}</h1>
        {#if project.archivedAt}
          <span class="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700">
            Archived
          </span>
        {/if}
      </div>
      {#if project.description}
        <p class="mt-2 text-slate-600">{project.description}</p>
      {/if}
      {#if project.tags.length > 0}
        <ul class="mt-3 flex flex-wrap gap-2">
          {#each project.tags as tag (tag)}
            <li class="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
              {tag}
            </li>
          {/each}
        </ul>
      {/if}
      <p class="mt-3 text-sm text-slate-500">
        Created {formatDate(project.createdAt)} · Your role: {project.role}
      </p>
    </div>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Export project</h2>
      <p class="mt-1 text-sm text-slate-600">
        Download an encrypted, portable snapshot of this project — every secret, dependent system,
        rotation history, service, certificate, domain, and machine user definition — as a single
        file. A random encryption key is generated and shown to you exactly once: it is never stored
        anywhere on the server. If you lose it, the export file is permanently unrecoverable — save
        the key somewhere safe before you close this page.
      </p>

      {#if exportError}
        <p class="mt-3 text-sm text-red-700">{exportError}</p>
      {/if}

      {#if revealedExportKey}
        <div class="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <p class="font-semibold text-amber-900">
            Your export key — copy it now, it will not be shown again.
          </p>
          <code class="mt-2 block break-all rounded-lg bg-white px-3 py-2 text-xs text-slate-900">
            {revealedExportKey}
          </code>
          <label class="mt-3 flex items-center gap-2 text-xs text-amber-900">
            <input type="checkbox" bind:checked={exportKeyAcknowledged} />
            I have saved this key — it cannot be retrieved again.
          </label>
          <button
            type="button"
            class="mt-3 rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!exportKeyAcknowledged}
            onclick={dismissExportKey}
          >
            Done
          </button>
        </div>
      {:else}
        <button
          type="button"
          class="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={exporting}
          onclick={() => void onExportProject(project.id)}
        >
          {exporting ? 'Exporting…' : 'Export project'}
        </button>
      {/if}
    </section>

    {#if dashboard}
      <dl class="grid gap-4 sm:grid-cols-3">
        <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <dt class="text-sm text-slate-500">Members</dt>
          <dd class="mt-1 text-2xl font-bold text-slate-950">
            {project.memberCount}
            {project.memberCount === 1 ? 'member' : 'members'}
          </dd>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <dt class="text-sm text-slate-500">Expiring soon (30 days)</dt>
          <dd class="mt-1 text-2xl font-bold text-slate-950">
            {#if dashboard.credentialStats.expiringSoon > 0}
              {dashboard.credentialStats.expiringSoon} expiring soon
            {:else}
              Nothing expiring soon
            {/if}
          </dd>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <dt class="text-sm text-slate-500">Service health</dt>
          <dd class="mt-1 text-2xl font-bold text-slate-950">
            {#if dashboard.monitoredServiceHealth.healthy + dashboard.monitoredServiceHealth.degraded + dashboard.monitoredServiceHealth.down === 0}
              No services configured yet
            {:else}
              {dashboard.monitoredServiceHealth.healthy} healthy ·
              {dashboard.monitoredServiceHealth.degraded} degraded ·
              {dashboard.monitoredServiceHealth.down} down
            {/if}
          </dd>
        </div>
      </dl>
    {/if}
  </section>
{/if}
