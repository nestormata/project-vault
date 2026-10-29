<script lang="ts">
  import type { ProjectOverview } from '@project-vault/shared'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { externalUrlParts } from './project-settings-logic.js'
  import { canArchiveInProject } from '$lib/projects/project-write-access.js'
  import ArchivedBadge from './ArchivedBadge.svelte'
  import { formatDate } from '$lib/datetime.js'

  // Story 69.1: the project page's header card (name, archived badge, description, tags, created
  // and role) as one replaceable region. It receives `{ project }` and nothing else.
  let {
    project,
    data,
  }: { project: ProjectOverview; data?: Record<string, readonly unknown[]> | undefined } = $props()

  // Story 72-9: the settings page edits the project; its link shows when the API would allow it.
  const canManage = $derived(canArchiveInProject(page.data.user?.orgRole, project))
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
  {/if}
  {#if project.urls.length > 0}
    <ul class="mt-3 space-y-1 text-sm">
      {#each project.urls as url (url)}
        {@const parts = externalUrlParts(url)}
        {#if parts}
          <li>
            <a
              class="break-all font-medium text-slate-800 underline"
              href={`${parts.scheme}://${parts.rest}`}
              target="_blank"
              rel="noopener noreferrer">{url}</a
            >
          </li>
        {/if}
      {/each}
    </ul>
  {/if}<InjectionPoint name="project.detail.summary" props={{ project }} {data} />
  <p class="mt-3 text-sm text-slate-500">
    Created {formatDate(project.createdAt)} · Your role: {project.role}
    {#if canManage}
      ·
      <a
        class="font-medium text-slate-800 underline"
        href={resolve(`/projects/${project.id}/settings`)}
      >
        Project settings
      </a>
    {/if}
  </p>
</div>
