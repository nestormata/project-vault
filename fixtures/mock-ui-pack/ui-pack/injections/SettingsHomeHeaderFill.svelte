<script lang="ts">
  // Story 69.6 AC-5 M3 region point: `settings.home.header`, the child of a region component the pack
  // replaces by wrapping PV's original through `pv-original:` and forwarding `children`, so the point
  // survives the replacement.
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<p data-testid="mock-p6-settings-home-header" data-route={routeId}>
  mock-ui-pack:m3-p6-settings.home.header
</p>
