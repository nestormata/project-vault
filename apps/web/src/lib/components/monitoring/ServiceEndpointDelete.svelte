<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { EndpointRowPointProps } from '$lib/components/composition/injection-points.js'
  import AssetDeletePanel from './AssetDeletePanel.svelte'

  // Story 69.3: the endpoint detail page's delete panel as one replaceable region. The page renders
  // it for roles that can manage monitored assets only and keeps the delete state. A contribution at
  // `project.service-endpoints-detail.delete` receives `{ project, endpoint, orgRole }` and renders
  // right after the panel.
  let {
    project,
    endpoint,
    orgRole,
    deleteError,
    onDelete,
    data,
  }: {
    project: EndpointRowPointProps['project']
    endpoint: EndpointRowPointProps['endpoint']
    orgRole: EndpointRowPointProps['orgRole']
    deleteError: string | null
    onDelete: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints-detail.delete -->
<RegionFragment>
  <AssetDeletePanel
    note="Deleting this endpoint will also resolve any active alerts for it."
    {deleteError}
    {onDelete}
  /><InjectionPoint
    name="project.service-endpoints-detail.delete"
    props={{ project, endpoint, orgRole }}
    {data}
  />
</RegionFragment>
