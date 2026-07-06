<script lang="ts">
  import { resolve } from '$app/paths'
  import ServiceStatusItem from '$lib/components/dashboard/ServiceStatusItem.svelte'

  let { data } = $props()

  const hasAnyServices = $derived(data.dashboard.projects.length > 0)
</script>

<svelte:head>
  <title>Health | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Health</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Cross-project health</h1>
    <p class="mt-2 text-slate-600">
      Live status for every monitored service across your organization's projects.
    </p>

    {#if hasAnyServices}
      <dl class="mt-5 grid gap-3 sm:grid-cols-3">
        <div class="rounded-2xl bg-emerald-50 p-4">
          <dt class="text-sm text-emerald-700">Healthy</dt>
          <dd class="text-2xl font-bold text-emerald-900">{data.dashboard.summary.healthy}</dd>
        </div>
        <div class="rounded-2xl bg-amber-50 p-4">
          <dt class="text-sm text-amber-700">Degraded</dt>
          <dd class="text-2xl font-bold text-amber-900">{data.dashboard.summary.degraded}</dd>
        </div>
        <div class="rounded-2xl bg-red-50 p-4">
          <dt class="text-sm text-red-700">Down</dt>
          <dd class="text-2xl font-bold text-red-900">{data.dashboard.summary.down}</dd>
        </div>
      </dl>
    {/if}
  </div>

  {#if hasAnyServices}
    <div class="grid gap-4 sm:grid-cols-2">
      {#each data.dashboard.projects as project (project.projectId)}
        <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="flex items-center justify-between gap-2">
            <a
              class="font-semibold text-slate-950 underline"
              href={resolve(`/projects/${project.projectId}/credentials`)}
            >
              {project.projectName}
            </a>
          </div>
          <ul class="mt-3 space-y-2">
            {#each project.services as service (service.id)}
              <li
                class="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2"
              >
                <ServiceStatusItem
                  name={service.name}
                  status={service.status}
                  lastCheckedAt={service.lastCheckedAt}
                />
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  {:else}
    <div class="rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">No services monitored yet.</p>
      <p class="mt-1 text-sm text-slate-500">
        Register a service endpoint on a project to see its live status here.
      </p>
    </div>
  {/if}
</section>
