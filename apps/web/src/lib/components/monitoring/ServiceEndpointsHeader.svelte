<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import AssetListHeader from './AssetListHeader.svelte'
  import type { EndpointListRegionProps } from './endpoint-region-props.js'

  // Story 69.3: the endpoint list's header card (eyebrow, title, add link) as one replaceable
  // region. A contribution at `project.service-endpoints.header` receives `{ project, orgRole, endpoints }` and renders
  // right after the header card.
  let {
    project,
    orgRole,
    endpoints,
    projectId,
    canManage,
    data,
  }: EndpointListRegionProps & { projectId: string; canManage: boolean } = $props()
</script>

<!-- @region project.service-endpoints.header -->
<RegionFragment>
  <AssetListHeader
    eyebrow="Endpoints"
    title="HTTP endpoint monitors"
    addHref={`/projects/${projectId}/service-endpoints/new`}
    addLabel="Add endpoint"
    {canManage}
  >
    Endpoints checked on a schedule; status feeds the org-wide health dashboard and public status
    page.
  </AssetListHeader><InjectionPoint
    name="project.service-endpoints.header"
    props={{ project, orgRole, endpoints }}
    {data}
  />
</RegionFragment>
