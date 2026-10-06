<script lang="ts">
  // Story 69.6 M3 region point: `platform.home.nav-cards`, after PV's nav cards, which PV renders
  // only for a platform operator. `runs` counts the loads this server process ran: a caller PV denied
  // (`allowed: false`) must never move it (Story 69.7 denial skip).
  let { data = null }: { data?: { runs?: number; operator?: string } | null } = $props()
</script>

<p data-testid="mock-p6-platform-nav">
  mock-ui-pack:m3-p6-platform.home.nav-cards runs={data?.runs ?? 'none'} operator={data?.operator ??
    'none'}
</p>
