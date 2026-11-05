<script lang="ts">
  // Story 69.6 M3 region point: `app.layout.search`, rendered right after PV's global search dialog in
  // the signed-in layout. Plain markup (DW-505): no `<svelte:head>`.
  // Story 72.18: the same fill registers a results provider with the palette, the way CM adds its
  // tenant/group results without replacing `GlobalSearch`. `mockpack` finds the Mock Billing page and
  // an action result; `mockpack-fail` makes the provider reject, `mockpack-slow` never answers.
  // `data-mock-search-query` records the query the provider was actually asked, so a test can see
  // that a new search has started while the previous rows are still on screen.
  import { resolve } from '$app/paths'
  import { registerSearchProvider } from '$lib/components/shell/search-providers.svelte.js'

  let { routeId = '' }: { routeId?: string } = $props()

  registerSearchProvider({
    id: 'mock-ui-pack',
    timeoutMs: 800,
    search: async (query) => {
      document.documentElement.dataset['mockSearchQuery'] = query
      const term = query.toLowerCase()
      if (term.includes('mockpack-fail')) throw new Error('mock provider failure')
      if (term.includes('mockpack-slow')) return new Promise(() => {})
      if (!term.includes('mockpack')) return []
      return [
        {
          id: 'billing',
          label: 'Mock Billing page',
          hint: 'mock-ui-pack:m3-search-provider',
          group: 'Mock pack',
          href: resolve('/billing'),
        },
        {
          id: 'action',
          label: 'Mock pack action',
          group: 'Mock pack',
          action: () => {
            document.documentElement.dataset['mockSearchAction'] = 'ran'
          },
        },
      ]
    },
  })
</script>

<p data-testid="mock-p6-layout-search" data-route={routeId}>mock-ui-pack:m3-p6-app.layout.search</p>
