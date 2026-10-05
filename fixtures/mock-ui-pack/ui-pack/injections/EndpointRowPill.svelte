<script lang="ts">
  // Story 69.3, M3 at the per-row REGION point (`project.service-endpoints.row`): one pill per
  // endpoint row, rendered INSIDE the row's Monitoring cell (a block must never land between `<tr>`
  // siblings). The point is rendered once per row and its `data` is per page, not per row, so the pill
  // reads the row's own endpoint from `props.endpoint` (Open Q3). Component only, no load: it is the
  // "no opt-in" shape of the mechanism. Plain markup (DW-505).
  let {
    endpoint = null,
  }: {
    endpoint?: { id?: string; name?: string } | null
  } = $props()
</script>

<span data-testid="mock-endpoint-pill" data-endpoint={endpoint?.id ?? ''}>
  mock-ui-pack:m3-row-pill {endpoint?.id ?? 'none'}
</span>
