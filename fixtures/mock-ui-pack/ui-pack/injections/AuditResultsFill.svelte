<script lang="ts">
  // Story 69.4 M3 region point: `settings.audit.results`, inside PV's owner-only gate. The load
  // authorizes on its own (D3): a caller who is not an owner gets `{}` and this renders nothing.
  let {
    data = null,
    orgRole = '',
  }: {
    data?: { marker?: string; rows?: number; limitedStatus?: number; runs?: number } | null
    orgRole?: string
  } = $props()
</script>

{#if data?.marker}
  <p data-testid="mock-p5-audit-results">
    {data.marker} rows={data.rows} role={orgRole} limited={data.limitedStatus} runs={data.runs}
  </p>
{/if}
