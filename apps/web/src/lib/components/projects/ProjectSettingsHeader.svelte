<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'

  // Story 72-9: the heading of the project settings page.
  let { projectId, name, children }: { projectId: string; name: string; children?: Snippet } =
    $props()
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
  {@render children?.()}
</div>
