<script lang="ts">
  import type { getHealthDashboard } from '$lib/api/health-dashboard.js'
  import type { Snippet } from 'svelte'
  import ServiceStatusItem from '$lib/components/dashboard/ServiceStatusItem.svelte'
  import { resolve } from '$app/paths'

  let {
    hasAnyServices,
    projects,
    singleProjectId,
    children,
  }: {
    hasAnyServices: boolean
    projects: Awaited<ReturnType<typeof getHealthDashboard>>['projects']
    singleProjectId: string | null
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if hasAnyServices}
  <div class="grid gap-4 sm:grid-cols-2">
    {#each projects as project (project.projectId)}
      <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <a
            class="font-semibold text-slate-950 underline"
            href={resolve(`/projects/${project.projectId}/credentials`)}
          >
            {project.projectName}
          </a>
          <a
            class="text-sm font-medium text-slate-700 underline"
            href={resolve(`/projects/${project.projectId}/service-endpoints`)}
          >
            Manage endpoints
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
      <a
        class="font-medium text-slate-700 underline"
        href={resolve(
          singleProjectId ? `/projects/${singleProjectId}/service-endpoints` : '/projects'
        )}
      >
        Register a service endpoint on a project to see its live status here.
      </a>
    </p>
  </div>
{/if}
