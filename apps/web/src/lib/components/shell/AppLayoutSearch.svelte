<script lang="ts">
  import type { Snippet } from 'svelte'
  import GlobalSearch from './GlobalSearch.svelte'
  import { provideSearchProviders } from './search-providers.svelte.js'

  // Story 69.6: the global search dialog as one replaceable region. `open` is passed straight through
  // to GlobalSearch (the layout's Ctrl/Cmd-K handler and the header button toggle it); `children` is
  // the region's injection point, rendered right after the dialog without adding a DOM node.
  let { open = $bindable(false), children }: { open?: boolean; children?: Snippet } = $props()

  // Story 72.18: the registry GlobalSearch reads its extra results providers from. A fill of this
  // region's injection point registers into it (`registerSearchProvider`). It adds no DOM.
  provideSearchProviders()
</script>

<GlobalSearch bind:open />{@render children?.()}
