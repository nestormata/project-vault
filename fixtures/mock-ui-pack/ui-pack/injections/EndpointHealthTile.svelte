<script lang="ts">
  import { enhance } from '$app/forms'

  // Story 69.3, M3 at a REGION point (`project.service-endpoints-detail.history`): a health tile
  // injected into PV's own endpoint detail page, inside the "Recent health checks" section after
  // PV's own history. Its server data comes from a load that PV runs through the host route's
  // behavior table because the pack opted in with `hostRoutes` (Q12 option B). Plain markup only
  // (no nested `<svelte:head>`, DW-505).
  let {
    data = null,
    endpoint = null,
    routeId = '',
  }: {
    data?: {
      projectId?: string | null
      serviceEndpointId?: string | null
      apiStatus?: number | null
    } | null
    endpoint?: { id?: string; name?: string } | null
    routeId?: string
  } = $props()
</script>

<div data-testid="mock-endpoint-health" data-route={routeId} data-endpoint={endpoint?.id ?? ''}>
  <p data-testid="mock-endpoint-health-load">
    mock-ui-pack:m3-endpoint-load endpoint={data?.serviceEndpointId ?? 'none'} status={data?.apiStatus ??
      'none'}
  </p>
  <form method="POST" action="?/project.service-endpoints-detail.history.ping" use:enhance>
    <label for="mock-endpoint-health-note">Health note</label>
    <input
      id="mock-endpoint-health-note"
      name="title"
      aria-describedby="mock-endpoint-health-help"
    />
    <span id="mock-endpoint-health-help">Saved through the pack's own API route.</span>
    <button type="submit">Save health note</button>
  </form>
</div>
