<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type { ProjectSummary } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import DashboardPlaceholderGrid from './DashboardPlaceholderGrid.svelte'

  // Story 69.1: the monitoring grid as one replaceable region, rendered by all three dashboard
  // branches (selected project with a summary, selected project without one, no project) with their
  // own grid props. The point lives here once. `project` is null in the no-project branch.
  let {
    project,
    data,
    ...grid
  }: {
    project: ProjectSummary | null
    data?: Record<string, readonly unknown[]> | undefined
  } & Omit<ComponentProps<typeof DashboardPlaceholderGrid>, 'children'> = $props()
</script>

<!-- @region dashboard.home.monitoring -->
<DashboardPlaceholderGrid {...grid}
  ><InjectionPoint
    name="dashboard.home.monitoring"
    props={{ project }}
    {data}
  /></DashboardPlaceholderGrid
>
