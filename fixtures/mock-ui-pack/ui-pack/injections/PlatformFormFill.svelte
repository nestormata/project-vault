<script lang="ts">
  // Story 69.10 M3 sub-region point: `platform.settings.form`, a render-only fill that lets the probe-order
  // e2e prove it lands between the two PV sections it targets (DOM order).
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<p data-testid="mock-p10-settings-form" data-route={routeId}>
  mock-ui-pack:m3-p10-platform.settings.form
</p>
