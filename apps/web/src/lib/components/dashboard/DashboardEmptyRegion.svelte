<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import CrossProjectEmptyState from './CrossProjectEmptyState.svelte'
  import DashboardMonitoringSection from './DashboardMonitoringSection.svelte'

  // Story 69.1: the dashboard when there is no selected project (the cross-project empty state and
  // the empty monitoring grid) as one replaceable region. No point props.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region dashboard.home.empty -->
<div class="space-y-6">
  <CrossProjectEmptyState />
  <DashboardMonitoringSection
    project={null}
    hasCredentials={false}
    hasServices={false}
    {data}
  /><InjectionPoint name="dashboard.home.empty" {data} />
</div>
