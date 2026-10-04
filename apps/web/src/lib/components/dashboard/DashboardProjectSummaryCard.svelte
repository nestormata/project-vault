<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type { ProjectDashboard, ProjectSummary } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import StatTile from '$lib/components/StatTile.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import DashboardProjectHeading from './DashboardProjectHeading.svelte'
  import DashboardProjectSelector from './DashboardProjectSelector.svelte'

  // Story 69.1: the selected project's card (selector, heading, four figures) as one replaceable
  // region. It receives `{ project }` (the selected project) and nothing else; `projects` feeds the
  // selector and `dashboard` the figures. A contribution's markup lands at the end of the figures
  // `<dl>`, so it should itself be `<div><dt>..</dt><dd>..</dd></div>` shaped.
  let {
    project,
    projects,
    dashboard,
    data,
  }: {
    project: ProjectSummary
    projects: ComponentProps<typeof DashboardProjectSelector>['projects']
    dashboard: ProjectDashboard
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region dashboard.home.project-summary -->
<section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <DashboardProjectSelector {projects} selectedProject={project} />
  <DashboardProjectHeading {project} linked={true} showDescription={true} />
  <dl class="mt-5 grid gap-3 sm:grid-cols-3">
    <StatTile label={m.dashboard_secrets_label()}>{dashboard.credentialStats.active}</StatTile>
    <StatTile label={m.dashboard_expiring_soon_heading()}>
      {dashboard.credentialStats.expiringSoon}
    </StatTile>
    <StatTile label={m.dashboard_alerts_label()}>{dashboard.unresolvedAlertCount}</StatTile>
    <StatTile label={m.dashboard_monitored_services_label()} variant="subtle-compact">
      {m.dashboard_service_health_summary({
        healthy: dashboard.monitoredServiceHealth.healthy,
        degraded: dashboard.monitoredServiceHealth.degraded,
        down: dashboard.monitoredServiceHealth.down,
      })}
    </StatTile><InjectionPoint name="dashboard.home.project-summary" props={{ project }} {data} />
  </dl>
</section>
