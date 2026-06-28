<script lang="ts">
  import CrossProjectEmptyState from '$lib/components/dashboard/CrossProjectEmptyState.svelte'
  import DashboardPlaceholderGrid from '$lib/components/dashboard/DashboardPlaceholderGrid.svelte'
  import { suggestedActionLabels } from '$lib/components/dashboard/dashboard-copy.js'

  let { data } = $props()
</script>

<svelte:head>
  <title>Dashboard | Project Vault</title>
</svelte:head>

{#if data.selectedProject && data.dashboard}
  <div class="space-y-6">
    <section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Project dashboard</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.selectedProject.name}</h1>
      {#if data.selectedProject.description}
        <p class="mt-2 text-slate-600">{data.selectedProject.description}</p>
      {/if}
      <dl class="mt-5 grid gap-3 sm:grid-cols-3">
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Credentials</dt>
          <dd class="text-2xl font-bold text-slate-950">
            {data.dashboard.credentialStats.active}
          </dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Expiring soon</dt>
          <dd class="text-2xl font-bold text-slate-950">
            {data.dashboard.credentialStats.expiringSoon}
          </dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Alerts</dt>
          <dd class="text-2xl font-bold text-slate-950">{data.dashboard.unresolvedAlertCount}</dd>
        </div>
      </dl>
    </section>

    <DashboardPlaceholderGrid />

    {#if data.dashboard.isEmpty}
      <section class="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 class="font-semibold">Suggested next actions</h2>
        <ul class="mt-3 space-y-2 text-sm text-slate-600">
          {#each data.dashboard.suggestedActions as action (action)}
            <li>{suggestedActionLabels[action]}</li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
{:else}
  <div class="space-y-6">
    <CrossProjectEmptyState />
    <DashboardPlaceholderGrid />
  </div>
{/if}
