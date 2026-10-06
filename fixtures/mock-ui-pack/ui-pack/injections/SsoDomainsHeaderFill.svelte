<script lang="ts">
  // Story 69.6 AC-5 M3 region point: `settings.sso-domains.header`, the child of a region component the
  // pack replaces FULLY (no `pv-original:`, no `children`): the point is dropped, this never renders.
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<p data-testid="mock-p6-sso-header" data-route={routeId}>
  mock-ui-pack:m3-p6-settings.sso-domains.header
</p>
