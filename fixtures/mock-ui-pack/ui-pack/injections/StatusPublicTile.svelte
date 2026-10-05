<script lang="ts">
  // Story 69.3, M3 at a REGION point of the ANONYMOUS public status page (`status.detail.services`):
  // a tile rendered after PV's own list for a valid token. It echoes everything it received in
  // `data-received` so the mechanism e2e can prove the token is nowhere in the props or the load data.
  // Plain markup (DW-505).
  let {
    data = null,
    statusPage = null,
    ...rest
  }: {
    data?: { runs?: number; user?: string } | null
    statusPage?: { services?: unknown[] } | null
  } = $props()
</script>

<p data-testid="mock-public-status" data-received={JSON.stringify({ data, statusPage, rest })}>
  mock-ui-pack:m3-public-load runs={data?.runs ?? 'none'} user={data?.user ?? 'none'} services={statusPage
    ?.services?.length ?? 0}
</p>
