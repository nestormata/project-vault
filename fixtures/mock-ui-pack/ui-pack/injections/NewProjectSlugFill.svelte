<script lang="ts">
  // Story 69.12 M3 sub-region point: `project.new.slug`, a render-only fill that lets the probe-order
  // e2e prove it lands right after the PV section it targets (DOM order).
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<p data-testid="mock-p12-project-slug" data-route={routeId}>mock-ui-pack:m3-p12-project.new.slug</p>
