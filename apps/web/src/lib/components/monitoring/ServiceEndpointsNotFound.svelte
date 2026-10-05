<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import ProjectNotFoundBanner from './ProjectNotFoundBanner.svelte'
  import type { EndpointListRegionProps } from './endpoint-region-props.js'

  // Story 69.3: the "project not found" banner as one replaceable region. It renders in the 404
  // state only, where the layout's `project` is null, so a contribution at
  // `project.service-endpoints.not-found` receives `{ project, orgRole, endpoints }` (null there).
  let { project, orgRole, endpoints, data }: EndpointListRegionProps = $props()
</script>

<!-- @region project.service-endpoints.not-found -->
<RegionFragment>
  <ProjectNotFoundBanner /><InjectionPoint
    name="project.service-endpoints.not-found"
    props={{ project, orgRole, endpoints }}
    {data}
  />
</RegionFragment>
