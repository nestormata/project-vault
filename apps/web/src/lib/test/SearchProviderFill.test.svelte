<script lang="ts">
  // Story 72.18: stands in for a host's fill of the `app.layout.search` injection point. It
  // registers one results provider for as long as it is mounted, the way a pack fill does.
  import {
    registerSearchProvider,
    type SearchProvider,
  } from '$lib/components/shell/search-providers.svelte.js'

  let { provider }: { provider: SearchProvider } = $props()

  // Read through the prop on every use, so the registered provider follows it.
  registerSearchProvider({
    get id() {
      return provider.id
    },
    get timeoutMs() {
      return provider.timeoutMs
    },
    search: (query, context) => provider.search(query, context),
  })
</script>
