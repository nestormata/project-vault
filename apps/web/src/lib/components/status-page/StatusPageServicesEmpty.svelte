<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'

  // Story 69.11: the notice shown when the project has no monitored service endpoints to publish.
  let {
    project,
    capabilities,
    serviceEndpoints,
    projectId,
    data,
  }: {
    project: StatusPageAdminPointProps['project']
    capabilities: StatusPageAdminPointProps['capabilities']
    serviceEndpoints: StatusPageAdminPointProps['serviceEndpoints']
    data?: Record<string, readonly unknown[]> | undefined
    projectId: string
  } = $props()
</script>

<!-- @region project.status-page.services-empty -->
<RegionFragment>
  <p class="text-slate-600">
    No monitored service endpoints exist for this project yet —
    <a
      class="font-medium text-slate-950 underline"
      href={resolve(`/projects/${projectId}/service-endpoints`)}
    >
      register one first
    </a>
    .
  </p>
  <InjectionPoint
    name="project.status-page.services-empty"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</RegionFragment>
