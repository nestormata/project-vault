<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { canArchiveInProject } from '$lib/projects/project-write-access.js'
  import type { ProjectListPage } from '$lib/api/projects.js'
  import type { ProjectsListActions } from './projects-list-actions.svelte.js'

  // Story 69.11: the links and the archive/unarchive button of one project card.
  let {
    project,
    actions,
  }: { project: ProjectListPage['items'][number]; actions: ProjectsListActions } = $props()

  // DW-618: the API's archive rule, with the org role from the layout data.
  const canArchive = $derived(canArchiveInProject(page.data.user?.orgRole, project))
</script>

<div class="mt-4 flex flex-wrap items-center gap-3">
  <a
    class="inline-block rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
    href={resolve(`/projects/${project.id}`)}
  >
    View project
  </a>
  {#if !project.isArchived}
    <a
      class="inline-block rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-900"
      href={resolve(`/projects/${project.id}/credentials`)}
    >
      View secrets
    </a>
  {/if}
  {#if canArchive}
    {#if project.isArchived}
      <button
        type="button"
        class="cursor-pointer text-sm font-medium text-slate-700 underline hover:text-slate-950 focus-visible:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
        title="Unarchive this project"
        disabled={actions.busyProjectId === project.id}
        onclick={() => actions.onUnarchive(project)}
      >
        Unarchive
      </button>
    {:else}
      <button
        type="button"
        class="cursor-pointer text-sm font-medium text-amber-700 underline hover:text-amber-900 focus-visible:text-amber-900 disabled:cursor-not-allowed disabled:opacity-60"
        title="Archive this project"
        disabled={actions.busyProjectId === project.id}
        onclick={() => actions.onArchive(project)}
      >
        Archive project
      </button>
    {/if}
  {/if}
</div>
