<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { EndpointListPointProps } from '$lib/components/composition/injection-points.js'
  import type { ComponentProps } from 'svelte'
  import type { OrgRole } from '$lib/monitoring/permissions.js'
  import ActiveAlertsPanel from './ActiveAlertsPanel.svelte'

  // Story 69.3: the "Active alerts" panel as one replaceable region. A contribution at
  // `project.service-endpoints.alerts` receives `{ project, orgRole, endpoints }` and renders right
  // after the panel.
  let {
    project,
    orgRole,
    endpoints,
    alerts,
    endpointNames,
    projectId,
    data,
  }: {
    project: EndpointListPointProps['project']
    orgRole: OrgRole
    endpoints: EndpointListPointProps['endpoints']
    alerts: ComponentProps<typeof ActiveAlertsPanel>['alerts']
    endpointNames: ComponentProps<typeof ActiveAlertsPanel>['endpoints']
    projectId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints.alerts -->
<RegionFragment>
  <ActiveAlertsPanel {alerts} endpoints={endpointNames} {orgRole} {projectId} /><InjectionPoint
    name="project.service-endpoints.alerts"
    props={{ project, orgRole, endpoints }}
    {data}
  />
</RegionFragment>
