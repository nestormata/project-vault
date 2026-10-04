<script lang="ts">
  import { enhance } from '$app/forms'

  // Story 69.1, M3 at a REGION point (`project.detail.tiles`): a tile injected into PV's own project
  // page, which the pack did not override. It sits at the end of PV's stat `<dl>`, so it is itself
  // `<div><dt/><dd/></div>` shaped. Its server data comes from a load that PV runs through the host
  // route's behavior table because the pack opted in with `hostRoutes` (Q12 option B).
  let {
    data = null,
    project = null,
    routeId = '',
  }: {
    data?: { projectId?: string | null; apiStatus?: number | null; owner?: string | null } | null
    project?: { id?: string; name?: string } | null
    routeId?: string
  } = $props()
</script>

<div data-testid="mock-project-tile" data-route={routeId} data-project={project?.id ?? ''}>
  <dt>Mock tile</dt>
  <dd>
    <span data-testid="mock-project-tile-load">
      mock-ui-pack:m3-region-load project={data?.projectId ?? 'none'} status={data?.apiStatus ??
        'none'}
    </span>
    <form method="POST" action="?/project.detail.tiles.ping" use:enhance>
      <label for="mock-project-tile-title">Tile note</label>
      <input id="mock-project-tile-title" name="title" aria-describedby="mock-project-tile-help" />
      <span id="mock-project-tile-help">Saved through the pack's own API route.</span>
      <button type="submit">Save tile note</button>
    </form>
  </dd>
</div>
