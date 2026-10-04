<script lang="ts">
  import type { ProjectDashboard, ProjectOverview } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import StatTile from '$lib/components/StatTile.svelte'

  // Story 69.1: the project page's three figures (members, expiring soon, service health) as one
  // replaceable region. It receives `{ project }` and nothing else; `dashboard` is the figures'
  // source, never handed to a contribution. A contribution's markup lands at the end of the `<dl>`,
  // so it should itself be `<div><dt>..</dt><dd>..</dd></div>` shaped.
  let {
    project,
    dashboard,
    data,
  }: {
    project: ProjectOverview
    dashboard: ProjectDashboard
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const health = $derived(dashboard.monitoredServiceHealth)
</script>

<!-- @region project.detail.tiles -->
<dl class="grid gap-4 sm:grid-cols-3">
  <StatTile label="Members" variant="card">
    {project.memberCount}
    {project.memberCount === 1 ? 'member' : 'members'}
  </StatTile>
  <StatTile label="Expiring soon (30 days)" variant="card">
    {#if dashboard.credentialStats.expiringSoon > 0}
      {dashboard.credentialStats.expiringSoon} expiring soon
    {:else}
      Nothing expiring soon
    {/if}
  </StatTile>
  <StatTile label="Service health" variant="card">
    {#if health.healthy + health.degraded + health.down === 0}
      No services configured yet
    {:else}
      {health.healthy} healthy ·
      {health.degraded} degraded ·
      {health.down} down
    {/if}
  </StatTile><InjectionPoint name="project.detail.tiles" props={{ project }} {data} />
</dl>
