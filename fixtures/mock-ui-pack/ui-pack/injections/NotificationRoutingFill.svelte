<script lang="ts">
  // Story 69.4 M3 region point: `settings.notifications.routing`, inside PV's admin gate. Component
  // only: PV mounts it for an admin with routing and never for a plain member.
  let { routing = [] }: { routing?: readonly unknown[] } = $props()
</script>

<p data-testid="mock-p5-routing">
  mock-ui-pack:m3-p5-settings.notifications.routing routes={routing.length}
</p>
