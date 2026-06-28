<script lang="ts">
  import { suggestedActionLabels } from './dashboard-copy.js'
  import DashboardPlaceholderGrid from './DashboardPlaceholderGrid.svelte'

  let { project } = $props()
</script>

<section class="space-y-6">
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
      Preview only - this project is not saved.
    </p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">{project.name}</h1>
    <p class="mt-2 text-slate-600">{project.description}</p>
  </div>
  <DashboardPlaceholderGrid />
  <section class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">Suggested next actions</h2>
    <ul class="mt-3 space-y-2 text-sm text-slate-600">
      {#each project.dashboard.suggestedActions as action}
        <li>{suggestedActionLabels[action]}</li>
      {/each}
    </ul>
  </section>
</section>
