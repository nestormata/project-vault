<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { EndpointRowPointProps } from '$lib/components/composition/injection-points.js'
  import MonitoringPauseControl from './MonitoringPauseControl.svelte'

  // Story 69.3: the endpoint detail page's pause/resume card as one replaceable region. The page
  // renders it only when the endpoint reports a boolean paused flag (the same condition as before),
  // keeps the pause state and passes it down. A contribution at
  // `project.service-endpoints-detail.pause` receives `{ project, endpoint, orgRole }` and renders
  // right after the card.
  let {
    project,
    endpoint,
    orgRole,
    paused,
    canManage,
    submitting,
    errorMessage,
    onToggle,
    data,
  }: {
    project: EndpointRowPointProps['project']
    endpoint: EndpointRowPointProps['endpoint']
    orgRole: EndpointRowPointProps['orgRole']
    paused: boolean
    canManage: boolean
    submitting: boolean
    errorMessage: string | null
    onToggle: (paused: boolean) => boolean | Promise<boolean>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints-detail.pause -->
<RegionFragment>
  <MonitoringPauseControl
    {paused}
    pausedAt={endpoint.healthCheckPausedAt ?? null}
    lastKnownStatus={endpoint.status}
    {canManage}
    {submitting}
    {errorMessage}
    {onToggle}
  /><InjectionPoint
    name="project.service-endpoints-detail.pause"
    props={{ project, endpoint, orgRole }}
    {data}
  />
</RegionFragment>
