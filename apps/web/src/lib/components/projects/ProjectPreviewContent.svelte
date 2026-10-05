<script lang="ts">
  import type { Snippet } from 'svelte'
  import { getPreviewProject } from '$lib/state/preview-project.svelte.js'
  import ProjectDashboardEmptyState from '$lib/components/dashboard/ProjectDashboardEmptyState.svelte'

  let { children }: { children?: Snippet } = $props()

  let project = $derived(getPreviewProject())
</script>

{#if project}
  <ProjectDashboardEmptyState {project} />
{:else}
  <section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <h1 class="text-3xl font-bold">Preview project</h1>
    <p class="mt-2 text-slate-600">
      Preview project state is created only in the browser and resets on reload.
    </p>
  </section>
{/if}
{@render children?.()}
