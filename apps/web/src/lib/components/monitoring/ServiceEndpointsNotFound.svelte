<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { EndpointListPointProps } from '$lib/components/composition/injection-points.js'
  import ProjectNotFoundBanner from './ProjectNotFoundBanner.svelte'

  // Story 69.3: the "project not found" banner as one replaceable region. It renders in the 404
  // state only, where the layout's `project` is null, so a contribution at
  // `project.service-endpoints.not-found` receives `{ project, orgRole, endpoints }` (null there).
  let {
    project,
    orgRole,
    endpoints,
    data,
  }: {
    project: EndpointListPointProps['project']
    orgRole: EndpointListPointProps['orgRole']
    endpoints: EndpointListPointProps['endpoints']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints.not-found -->
<RegionFragment>
  <ProjectNotFoundBanner /><InjectionPoint
    name="project.service-endpoints.not-found"
    props={{ project, orgRole, endpoints }}
    {data}
  />
</RegionFragment>
