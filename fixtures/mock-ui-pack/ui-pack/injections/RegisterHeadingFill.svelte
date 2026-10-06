<script lang="ts">
  // Story 69.6 M3 region point: `auth.register.heading` on the public registration page. A RENDER-ONLY
  // fill (no load, no action): it must keep working while a throwing load on a sibling point of the
  // same page answers PV's own error page.
  let { params = {} }: { params?: Record<string, string> } = $props()
</script>

<p data-testid="mock-p6-register-heading" data-params={JSON.stringify(params)}>
  mock-ui-pack:m3-p6-auth.register.heading
</p>
