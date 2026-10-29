<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'

  // Story 72-9: the heading of the project settings page.
  let {
    projectId,
    name,
    canManage,
    children,
  }: { projectId: string; name: string; canManage: boolean; children?: Snippet } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Project settings</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">{name}</h1>
  <p class="mt-2 text-slate-600">
    Edit the name, description and links, or delete the project.
    <a class="font-medium text-slate-800 underline" href={resolve(`/projects/${projectId}`)}>
      Back to the project
    </a>
  </p>
  {#if !canManage}
    <p class="mt-3 text-slate-700">
      Only the project owner or an organization owner can edit or delete this project.
    </p>
  {/if}
  {@render children?.()}
</div>
