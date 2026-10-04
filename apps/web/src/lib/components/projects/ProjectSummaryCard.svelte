<script lang="ts">
  import type { ProjectOverview } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ArchivedBadge from './ArchivedBadge.svelte'
  import { formatDate } from '$lib/datetime.js'

  // Story 69.1: the project page's header card (name, archived badge, description, tags, created
  // and role) as one replaceable region. It receives `{ project }` and nothing else.
  let {
    project,
    data,
  }: { project: ProjectOverview; data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region project.detail.summary -->
<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <div class="flex flex-wrap items-center gap-2">
    <h1 class="text-3xl font-bold text-slate-950">{project.name}</h1>
    {#if project.archivedAt}
      <ArchivedBadge />
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
  {/if}<InjectionPoint name="project.detail.summary" props={{ project }} {data} />
  <p class="mt-3 text-sm text-slate-500">
    Created {formatDate(project.createdAt)} · Your role: {project.role}
  </p>
</div>
