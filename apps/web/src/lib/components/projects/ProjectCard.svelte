<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ProjectListPage } from '$lib/api/projects.js'
  import ProjectCardActions from './ProjectCardActions.svelte'
  import ProjectCounts from './ProjectCounts.svelte'
  import ProjectCardTags from './ProjectCardTags.svelte'
  import type { ProjectsListActions } from './projects-list-actions.svelte.js'

  // Story 69.11: one project card of the projects list (identity, counts, tags, actions).
  let {
    project,
    actions,
  }: { project: ProjectListPage['items'][number]; actions: ProjectsListActions } = $props()
</script>

<li
  class={[
    'rounded-2xl border p-5 shadow-sm',
    project.isArchived ? 'border-slate-200 bg-slate-50 opacity-75' : 'border-slate-200 bg-white',
  ].join(' ')}
>
  <div class="flex items-center gap-2">
    <h2 class="text-xl font-semibold text-slate-950">
      <a class="hover:underline" href={resolve(`/projects/${project.id}`)}>
        {project.name}
      </a>
    </h2>
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
  <ProjectCounts {project} />
  <ProjectCardTags {project} {actions} />
  <ProjectCardActions {project} {actions} />
</li>
