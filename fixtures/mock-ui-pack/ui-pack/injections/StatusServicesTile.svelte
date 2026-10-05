<script lang="ts">
  // Story 69.3, M3 at a REGION point (`project.status-page.services`): a tile injected into PV's own
  // status page admin screen, inside the "Services shown on the public page" card. The region renders
  // only when the page is enabled and the caller can manage it. The point's props carry the project
  // and the page's endpoints, never the public token; the load returns ids and a status only.
  // `data-received` echoes EVERYTHING the fill was handed (props and load data), so the mechanism e2e
  // can prove the public token is nowhere in it.
  let {
    data = null,
    project = null,
    serviceEndpoints = [],
    ...rest
  }: {
    data?: { projectId?: string | null; apiStatus?: number | null } | null
    project?: { id?: string } | null
    serviceEndpoints?: { id?: string }[]
  } = $props()
</script>

<p
  data-testid="mock-status-services"
  data-project={project?.id ?? ''}
  data-received={JSON.stringify({ data, project, serviceEndpoints, rest })}
>
  mock-ui-pack:m3-status-load project={data?.projectId ?? 'none'} status={data?.apiStatus ?? 'none'} endpoints={serviceEndpoints.length}
</p>
