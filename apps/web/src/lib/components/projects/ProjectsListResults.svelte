<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import ProjectCard from './ProjectCard.svelte'
  import type { ProjectsListActions } from './projects-list-actions.svelte.js'

  // Story 69.11: the results of the projects list (the empty state, or the grid of cards) as one
  // replaceable region. A card is a repeated row, so its parts are plain helper components that
  // share `actions` rather than regions of their own.
  let {
    projects,
    actions,
    data,
  }: {
    projects: ProjectListPage['items']
    actions: ProjectsListActions
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.home.results -->
<RegionFragment>
  {#if projects.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <h2 class="text-xl font-semibold text-slate-950">No projects yet</h2>
      <p class="mt-2 text-slate-600">
        Create your first project to unlock the real dashboard flow.
      </p>
    </div>
  {:else}
    <ul class="grid gap-4 md:grid-cols-2">
      {#each projects as project (project.id)}
        <ProjectCard {project} {actions} />
      {/each}
    </ul>
  {/if}<InjectionPoint name="project.home.results" {data} />
</RegionFragment>
