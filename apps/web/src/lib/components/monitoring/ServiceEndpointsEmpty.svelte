<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import EmptyAssetState from './EmptyAssetState.svelte'
  import type { EndpointListRegionProps } from './endpoint-region-props.js'

  // Story 69.3: the "no endpoints registered yet" card as one replaceable region. A contribution at
  // `project.service-endpoints.empty` receives `{ project, orgRole, endpoints }` and renders right after the card.
  let { project, orgRole, endpoints, data }: EndpointListRegionProps = $props()
</script>

<!-- @region project.service-endpoints.empty -->
<RegionFragment>
  <EmptyAssetState message="No service endpoints registered yet." /><InjectionPoint
    name="project.service-endpoints.empty"
    props={{ project, orgRole, endpoints }}
    {data}
  />
</RegionFragment>
