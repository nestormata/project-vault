<script lang="ts">
  import { resolve } from '$app/paths'

  type DashboardProject = {
    id: string
    name: string
    description?: string | null
  }

  let {
    project,
    linked = false,
    showDescription = false,
  }: {
    project: DashboardProject
    linked?: boolean
    showDescription?: boolean
  } = $props()
</script>

<p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Project dashboard</p>
<p class="mt-2 text-sm text-slate-600">Showing data for {project.name}</p>
<h1 class="mt-2 text-3xl font-bold text-slate-950">
  {#if linked}
    <a class="hover:underline" href={resolve(`/projects/${project.id}`)}>{project.name}</a>
  {:else}
    {project.name}
  {/if}
</h1>
{#if showDescription && project.description}
  <p class="mt-2 text-slate-600">{project.description}</p>
{/if}
