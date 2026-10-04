<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { EndpointListPointProps } from '$lib/components/composition/injection-points.js'
  import EmptyAssetState from './EmptyAssetState.svelte'

  // Story 69.3: the "no endpoints registered yet" card as one replaceable region. A contribution at
  // `project.service-endpoints.empty` receives `{ project, orgRole, endpoints }` and renders right after the card.
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

<!-- @region project.service-endpoints.empty -->
<RegionFragment>
  <EmptyAssetState message="No service endpoints registered yet." /><InjectionPoint
    name="project.service-endpoints.empty"
    props={{ project, orgRole, endpoints }}
    {data}
  />
</RegionFragment>
