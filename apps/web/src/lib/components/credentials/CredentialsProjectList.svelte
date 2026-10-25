<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'
  import type { Snippet } from 'svelte'

  type Project = ProjectListPage['items'][number]

  // The project cards of the credentials pages: shared identity header, page-specific body.
  let { projects, card }: { projects: Project[]; card: Snippet<[Project]> } = $props()
</script>

<ul class="grid gap-4 md:grid-cols-2">
  {#each projects as project (project.id)}
    <li class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 class="text-xl font-semibold text-slate-950">{project.name}</h2>
      <p class="mt-1 text-sm text-slate-500">{project.slug}</p>
      {@render card(project)}
    </li>
  {/each}
</ul>
