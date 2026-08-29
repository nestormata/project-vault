<script lang="ts">
  import { resolve } from '$app/paths'
  import { m } from '$lib/paraglide/messages.js'

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

<p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
  {m.dashboard_project_heading_label()}
</p>
<p class="mt-2 text-sm text-slate-600">
  {m.dashboard_project_heading_showing_data({ name: project.name })}
</p>
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
