<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { ProjectPointProps } from '$lib/components/composition/injection-points.js'
  import EntityNotFoundBanner from './EntityNotFoundBanner.svelte'

  // Story 69.3: the endpoint detail page's "Endpoint not found" banner as one replaceable region.
  // It renders in the not-found state only (a missing or foreign endpoint id, or an endpoint deleted
  // from this page), so a contribution at `project.service-endpoints-detail.not-found` receives
  // `{ project, endpoint: null }` and renders right after the banner. `project` is the layout's
  // project (null when the project itself is not found).
  let {
    project,
    projectId,
    data,
  }: {
    project: ProjectPointProps['project']
    projectId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints-detail.not-found -->
<RegionFragment>
  <EntityNotFoundBanner
    title="Endpoint not found"
    message="This endpoint does not exist or you do not have access."
    backHref={`/projects/${projectId}/service-endpoints`}
    backLabel="Back to endpoints"
  /><InjectionPoint
    name="project.service-endpoints-detail.not-found"
    props={{ project, endpoint: null }}
    {data}
  />
</RegionFragment>
