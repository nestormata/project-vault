<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import DashboardEmptyRegion from '$lib/components/dashboard/DashboardEmptyRegion.svelte'
  import DashboardMonitoringSection from '$lib/components/dashboard/DashboardMonitoringSection.svelte'
  import DashboardProjectSummaryCard from '$lib/components/dashboard/DashboardProjectSummaryCard.svelte'
  import DashboardSummaryUnavailable from '$lib/components/dashboard/DashboardSummaryUnavailable.svelte'
  import DashboardVaultSealed from '$lib/components/dashboard/DashboardVaultSealed.svelte'
  import OrgSummarySection from '$lib/components/dashboard/OrgSummarySection.svelte'
  import RecentActivitySection from '$lib/components/dashboard/RecentActivitySection.svelte'
  import SuggestedActionsSection from '$lib/components/dashboard/SuggestedActionsSection.svelte'
  import UpcomingRotationsSection from '$lib/components/dashboard/UpcomingRotationsSection.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{m.dashboard_page_title()} | Project Vault</title>
</svelte:head>

<InjectionPoint name="dashboard.home.before" data={data?.__inject} />
<InjectionPoint name="dashboard.home.header.actions" data={data?.__inject} />
{#if data.vaultSealed}
  <DashboardVaultSealed data={data?.__inject} />
{:else}
  {#if data.orgDashboard}
    <OrgSummarySection orgDashboard={data.orgDashboard} data={data?.__inject} />
  {/if}

  {#if data.selectedProject && data.dashboard}
    {@const project = data.selectedProject}
    {@const dashboard = data.dashboard}
    <div class="space-y-6">
      <DashboardProjectSummaryCard
        {project}
        projects={data.projects}
        {dashboard}
        data={data?.__inject}
      />
      <UpcomingRotationsSection
        {project}
        rotations={dashboard.upcomingRotations}
        data={data?.__inject}
      />
      <RecentActivitySection
        {project}
        events={dashboard.recentAccessEvents}
        data={data?.__inject}
      />
      <DashboardMonitoringSection
        {project}
        hasCredentials={dashboard.credentialStats.active +
          dashboard.credentialStats.expiringSoon +
          dashboard.credentialStats.expired >
          0}
        hasServices={dashboard.monitoredServiceHealth.healthy +
          dashboard.monitoredServiceHealth.degraded +
          dashboard.monitoredServiceHealth.down >
          0}
        certificates={data.monitoringAssets?.certificates}
        domains={data.monitoringAssets?.domains}
        data={data?.__inject}
      />

      {#if dashboard.suggestedActions.length > 0}
        <SuggestedActionsSection
          {project}
          actions={dashboard.suggestedActions}
          data={data?.__inject}
        />
      {/if}
    </div>
  {:else if data.selectedProject}
    <div class="space-y-6">
      <DashboardSummaryUnavailable
        project={data.selectedProject}
        projects={data.projects}
        data={data?.__inject}
      />
      <DashboardMonitoringSection
        project={data.selectedProject}
        hasCredentials={true}
        hasServices={true}
        certificates={data.monitoringAssets?.certificates}
        domains={data.monitoringAssets?.domains}
        data={data?.__inject}
      />
    </div>
  {:else}
    <DashboardEmptyRegion data={data?.__inject} />
  {/if}
{/if}
<InjectionPoint name="dashboard.home.after" data={data?.__inject} />
