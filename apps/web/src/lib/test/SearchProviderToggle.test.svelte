<script lang="ts">
  // Story 72.18: like SearchProviderHarness, but the fill can be removed while the palette stays.
  import AppLayoutSearch from '$lib/components/shell/AppLayoutSearch.svelte'
  import type { SearchProvider } from '$lib/components/shell/search-providers.svelte.js'
  import SearchProviderFill from './SearchProviderFill.test.svelte'

  let { provider, filled }: { provider: SearchProvider; filled: boolean } = $props()
</script>

<AppLayoutSearch open={true}>
  {#if filled}
    <SearchProviderFill {provider} />
  {/if}
</AppLayoutSearch>
