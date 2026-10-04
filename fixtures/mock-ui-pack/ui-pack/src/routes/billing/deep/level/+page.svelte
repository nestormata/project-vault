<script lang="ts">
  // M5 (design rule 8): a pack page renders PV's breadcrumbs for a node the pack inserted.
  import Breadcrumbs from '$lib/navigation/Breadcrumbs.svelte'
</script>

<!-- M2: a route at any depth, still no `/extensions/...` prefix. -->
<Breadcrumbs node="mock.crumb.deep" />
<h1 data-testid="mock-billing-deep">mock-ui-pack:m2-billing-deep</h1>
