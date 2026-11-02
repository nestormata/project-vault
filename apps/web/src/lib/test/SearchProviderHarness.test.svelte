<script lang="ts">
  // Story 72.18: the layout's search region as the signed-in layout composes it: AppLayoutSearch
  // with a fill rendered inside it (the `app.layout.search` injection point's place).
  import AppLayoutSearch from '$lib/components/shell/AppLayoutSearch.svelte'
  import type { SearchProvider } from '$lib/components/shell/search-providers.svelte.js'
  import SearchProviderFill from './SearchProviderFill.test.svelte'

  let { provider, open = $bindable(true) }: { provider: SearchProvider; open?: boolean } = $props()
</script>

<AppLayoutSearch bind:open>
  <SearchProviderFill {provider} />
</AppLayoutSearch>
