<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { ApiClientError } from '$lib/api/client.js'
  import { archiveProject, unarchiveProject } from '$lib/api/projects.js'

  let { data } = $props()

  let errorMessage = $state<string | null>(null)
  let busyProjectId = $state<string | null>(null)

  function toggleShowArchived(): void {
    const params = new URLSearchParams(page.url.searchParams)
    if (data.includeArchived) {
      params.delete('includeArchived')
    } else {
      params.set('includeArchived', 'true')
    }
    const query = params.toString()
    // Dynamic query string toggle on the current route — not a literal resolve() can type-check.
    // eslint-disable-next-line svelte/no-navigation-without-resolve
    void goto(query ? `?${query}` : '?', { invalidateAll: true })
  }

  async function onArchive(project: { id: string; name: string }): Promise<void> {
    if (busyProjectId) return
    const confirmed = confirm(
      `Archive "${project.name}"? Credentials and history are preserved; the project is hidden ` +
        'from active views. You can unarchive it later.'
    )
    if (!confirmed) return
    busyProjectId = project.id
    errorMessage = null
    try {
      await archiveProject(fetch, project.id)
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'active_rotations') {
        const rotationIds = (error.body as { rotationIds?: string[] } | null)?.rotationIds ?? []
        errorMessage = `This project has ${rotationIds.length} in-progress rotation(s). Complete or abandon them before archiving.`
      } else {
        errorMessage =
          error instanceof ApiClientError
            ? (error.message ?? 'Failed to archive project.')
            : 'Failed to archive project.'
      }
      busyProjectId = null
      return
    }
    // The archive itself already succeeded above — a refresh failure here is not an archive
    // failure, so it must not surface the "Failed to archive project" error message.
    try {
      await invalidateAll()
    } finally {
      busyProjectId = null
    }
  }

  async function onUnarchive(project: { id: string; name: string }): Promise<void> {
    if (busyProjectId) return
    busyProjectId = project.id
    errorMessage = null
    try {
      await unarchiveProject(fetch, project.id)
    } catch (error) {
      errorMessage =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to unarchive project.')
          : 'Failed to unarchive project.'
      busyProjectId = null
      return
    }
    try {
      await invalidateAll()
    } finally {
      busyProjectId = null
    }
  }
</script>

<svelte:head>
  <title>Projects | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Projects</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">Project dashboard</h1>
      <p class="mt-2 text-slate-600">
        Organize credentials, services, and future alerts by team or domain.
      </p>
    </div>
    <div class="flex flex-col items-stretch gap-2 sm:items-end">
      <a
        class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
        href={resolve('/projects/new')}
      >
        Create project
      </a>
      <button
        type="button"
        class="text-sm font-medium text-slate-600 underline"
        onclick={toggleShowArchived}
      >
        {data.includeArchived ? 'Hide archived' : 'Show archived'}
      </button>
    </div>
  </div>

  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}

  {#if data.projects.items.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <h2 class="text-xl font-semibold text-slate-950">No projects yet</h2>
      <p class="mt-2 text-slate-600">
        Create your first project to unlock the real dashboard flow.
      </p>
    </div>
  {:else}
    <ul class="grid gap-4 md:grid-cols-2">
      {#each data.projects.items as project (project.id)}
        <li
          class={[
            'rounded-2xl border p-5 shadow-sm',
            project.isArchived
              ? 'border-slate-200 bg-slate-50 opacity-75'
              : 'border-slate-200 bg-white',
          ].join(' ')}
        >
          <div class="flex items-center gap-2">
            <h2 class="text-xl font-semibold text-slate-950">{project.name}</h2>
            {#if project.isArchived}
              <span class="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700"
                >Archived</span
              >
            {/if}
          </div>
          <p class="mt-1 text-sm text-slate-500">{project.slug}</p>
          {#if project.description}
            <p class="mt-3 text-slate-600">{project.description}</p>
          {/if}
          <dl class="mt-4 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt class="text-slate-500">Credentials</dt>
              <dd class="font-semibold">{project.credentialCount}</dd>
            </div>
            <div>
              <dt class="text-slate-500">Expiring</dt>
              <dd class="font-semibold">{project.expiringCount}</dd>
            </div>
            <div>
              <dt class="text-slate-500">Alerts</dt>
              <dd class="font-semibold">{project.alertCount}</dd>
            </div>
          </dl>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            {#if !project.isArchived}
              <a
                class="inline-block rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-900"
                href={resolve(`/projects/${project.id}/credentials`)}
              >
                View credentials
              </a>
            {/if}
            {#if project.role === 'owner'}
              {#if project.isArchived}
                <button
                  type="button"
                  class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={busyProjectId === project.id}
                  onclick={() => onUnarchive(project)}
                >
                  Unarchive
                </button>
              {:else}
                <button
                  type="button"
                  class="text-sm font-medium text-amber-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={busyProjectId === project.id}
                  onclick={() => onArchive(project)}
                >
                  Archive project
                </button>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
