<script lang="ts">
  // Story 69.6 AC-5 M3 region point: `settings.sso-domains.panel`, the child of a region component the
  // pack does NOT replace, on the page whose header region it replaces: it keeps rendering.
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<p data-testid="mock-p6-sso-panel" data-route={routeId}>
  mock-ui-pack:m3-p6-settings.sso-domains.panel
</p>
