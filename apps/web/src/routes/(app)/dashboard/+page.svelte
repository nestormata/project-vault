<script lang="ts">
  import { resolve } from '$app/paths'
  import CrossProjectEmptyState from '$lib/components/dashboard/CrossProjectEmptyState.svelte'
  import DashboardPlaceholderGrid from '$lib/components/dashboard/DashboardPlaceholderGrid.svelte'
  import { suggestedActionLabels } from '$lib/components/dashboard/dashboard-copy.js'
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'

  let { data } = $props()

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
</script>

<svelte:head>
  <title>Dashboard | Project Vault</title>
</svelte:head>

{#if data.vaultSealed}
  <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
    <h1 class="text-xl font-semibold text-red-900">Vault sealed</h1>
    <p class="mt-2 text-red-800">{onboardingCopy.vaultSealedMessage}</p>
  </div>
{:else}
  {#if data.orgDashboard}
    <section class="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Organization</p>
      <h2 class="mt-2 text-2xl font-bold text-slate-950">Credential overview</h2>
      <dl class="mt-4 grid gap-3 sm:grid-cols-3">
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Total credentials</dt>
          <dd class="text-2xl font-bold text-slate-950">{data.orgDashboard.totalCredentials}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Expiring within 30 days</dt>
          <dd class="text-2xl font-bold text-slate-950">
            {data.orgDashboard.expiringWithin30Days.count}
          </dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Unresolved alerts</dt>
          <dd class="text-2xl font-bold text-slate-950">
            {data.orgDashboard.unresolvedAlertCount}
          </dd>
        </div>
      </dl>
      {#if data.orgDashboard.expiringWithin30Days.items.length > 0}
        <div class="mt-5">
          <h3 class="font-semibold text-slate-950">Expiring soon</h3>
          <ul class="mt-3 space-y-2">
            {#each data.orgDashboard.expiringWithin30Days.items as item (item.id)}
              <li
                class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
              >
                <div>
                  <a
                    class="font-semibold text-slate-950 underline"
                    href={resolve(`/projects/${item.projectId}/credentials/${item.id}`)}
                  >
                    {item.name}
                  </a>
                  <span class="ml-2 text-slate-500">{item.projectName}</span>
                </div>
                <span class="text-slate-600">Expires {formatDate(item.expiresAt)}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>
  {/if}

  {#if data.selectedProject && data.dashboard}
    <div class="space-y-6">
      <section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Project dashboard
        </p>
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
          <div class="rounded-2xl bg-slate-50 p-4">
            <dt class="text-sm text-slate-500">Monitored services</dt>
            <dd class="text-lg font-bold text-slate-950">
              {data.dashboard.monitoredServiceHealth.healthy} healthy ·
              {data.dashboard.monitoredServiceHealth.degraded} degraded ·
              {data.dashboard.monitoredServiceHealth.down} down
            </dd>
          </div>
        </dl>
      </section>

      <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-slate-950">Upcoming rotations</h2>
        {#if data.dashboard.upcomingRotations.length === 0}
          <p class="mt-3 text-sm text-slate-600">
            No credentials have an upcoming rotation scheduled.
          </p>
        {:else}
          <ul class="mt-4 space-y-2">
            {#each data.dashboard.upcomingRotations as rotation (rotation.credentialId)}
              <li
                class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
              >
                <a
                  class="font-semibold text-slate-950 underline"
                  href={resolve(
                    `/projects/${data.selectedProject.id}/credentials/${rotation.credentialId}`
                  )}
                >
                  {rotation.credentialName}
                </a>
                <span class="text-slate-600">{formatDate(rotation.scheduledAt)}</span>
                {#if rotation.status === 'overdue'}
                  <span
                    class="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800"
                  >
                    Overdue
                  </span>
                {:else}
                  <span
                    class="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                  >
                    Scheduled
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <DashboardPlaceholderGrid />

      {#if data.dashboard.isEmpty}
        <section class="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 class="font-semibold">Suggested next actions</h2>
          <ul class="mt-3 space-y-2 text-sm text-slate-600">
            {#each data.dashboard.suggestedActions as action (action)}
              <li>
                {#if action === 'add_credential' && data.selectedProject}
                  <a
                    class="font-medium text-slate-950 underline"
                    href={resolve(`/projects/${data.selectedProject.id}/credentials/new`)}
                  >
                    {suggestedActionLabels[action]}
                  </a>
                {:else if action === 'import_credentials' && data.selectedProject}
                  <a
                    class="font-medium text-slate-950 underline"
                    href={resolve(`/projects/${data.selectedProject.id}/credentials/import`)}
                  >
                    {suggestedActionLabels[action]}
                  </a>
                {:else}
                  {suggestedActionLabels[action]}
                {/if}
              </li>
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
{/if}
