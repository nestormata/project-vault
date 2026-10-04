<!-- Story 69.1: a fill at a REGION point (`project.detail.tiles`, rendered inside PV's
     ProjectStatTiles `<dl>`), opted in to behavior with `hostRoutes`. It shows what its load saw. -->
<script lang="ts">
  let { data = null }: { data?: { who?: string } | null } = $props()
</script>

<div>
  <dt>Region</dt>
  <dd data-testid="inject-region-tile" data-marker="PV_INJECT_REGION_MARKER_8e21f4">
    {data?.who ?? 'region:none'}
  </dd>
</div>
