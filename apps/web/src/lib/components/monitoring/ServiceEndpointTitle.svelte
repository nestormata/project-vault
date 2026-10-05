<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { EndpointRowPointProps } from '$lib/components/composition/injection-points.js'
  import DetailTitleCard from './DetailTitleCard.svelte'

  // Story 69.3: the endpoint detail page's title card as one replaceable region. A contribution at
  // `project.service-endpoints-detail.title` receives `{ project, endpoint, orgRole }` and renders right after
  // the card.
  let {
    project,
    endpoint,
    orgRole,
    data,
  }: {
    project: EndpointRowPointProps['project']
    endpoint: EndpointRowPointProps['endpoint']
    orgRole: EndpointRowPointProps['orgRole']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints-detail.title -->
<RegionFragment>
  <DetailTitleCard
    eyebrow="Endpoint"
    title={endpoint.name}
    note={`Current URL: ${endpoint.url}`}
  /><InjectionPoint
    name="project.service-endpoints-detail.title"
    props={{ project, endpoint, orgRole }}
    {data}
  />
</RegionFragment>
