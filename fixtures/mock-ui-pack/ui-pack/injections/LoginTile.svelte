<script lang="ts">
  // M3: a component injected into a NATIVE public PV page (sign-in) with its own server data.
  let { data = null }: { data?: { marker?: string } | null } = $props()
</script>

<p data-testid="mock-login-tile">mock-ui-pack:m3-login-tile {data?.marker ?? 'none'}</p>
