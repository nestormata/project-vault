<!--
  Story 72.7 (P3b): the search button of the rail shell's top bar below the `md` breakpoint, where
  the field-shaped `HeaderSearchField` is hidden and the rail is not shown. It opens the same global
  search; its accessible name is "Search". From `md` up the field takes over.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import SearchGlyph from '$lib/navigation/SearchGlyph.svelte'
  import { CONTROL_BORDER } from '$lib/components/ui/control-classes.js'

  let { onsearch }: { onsearch?: () => void } = $props()
</script>

<button
  type="button"
  class={`flex min-h-11 min-w-11 items-center justify-center rounded-xl border ${CONTROL_BORDER} bg-white text-slate-800 md:hidden`}
  aria-label={m.shell_search_open()}
  data-testid="header-search-icon"
  onclick={() => onsearch?.()}
>
  <SearchGlyph />
</button>
