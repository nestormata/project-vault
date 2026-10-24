<script lang="ts">
  // Story 69.11 M3 sub-region point: `project.home.results`, a render-only fill that lets the probe-order
  // e2e prove it lands right after the PV section it targets (DOM order).
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<p data-testid="mock-p11-projects-results" data-route={routeId}>
  mock-ui-pack:m3-p11-project.home.results
</p>
