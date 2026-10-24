<script lang="ts">
  // Story 69-14 M3 sub-region point: `project.credentials-rotate.value`, a render-only fill that lets the probe-order e2e prove it
  // lands between the two PV sections it targets (DOM order).
  let { routeId = '' }: { routeId?: string } = $props()
</script>

<span data-testid="mock-p11-project-credentials-rotate-value" data-route={routeId}
  >mock-ui-pack:m3-p11-project.credentials-rotate.value</span
>
