<script lang="ts">
  // Story 69.2, M3 at the REGION point `credential.detail.metadata`, which renders INSIDE PV's
  // metadata `<dl>`: the fill is a tile-shaped `<div><dt/><dd/></div>` so it joins the grid. Plain
  // markup, no nested `<svelte:head>` (DW-505), no secret.
  let {
    credential = null,
    projectRole = null,
  }: { credential?: { name?: string } | null; projectRole?: string | null } = $props()
</script>

<div data-testid="mock-credential-metadata">
  <dt>Mock tile</dt>
  <dd>mock-ui-pack:m3-metadata name={credential?.name ?? 'none'} role={projectRole ?? 'none'}</dd>
</div>
