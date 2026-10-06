<script lang="ts">
  // Story 69.6 M3 region point: `app.layout.search`, rendered right after PV's global search dialog in
  // the signed-in layout. Component only. Plain markup (DW-505): no `<svelte:head>`.
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<p data-testid="mock-p6-layout-search" data-route={routeId}>mock-ui-pack:m3-p6-app.layout.search</p>
