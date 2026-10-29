<!--
  Story 72.6 (P3a): the visible search field in the header. It looks like a text field and opens
  the global search (the same `onsearch` the nav's search button calls), so it is a button with
  the field's look, not a second input: typing happens in the palette. The shortcut hint is
  `Ctrl K` (the palette also answers to Cmd K). From the `md` breakpoint up it replaces the nav's
  icon button, which stays for narrow screens.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import SearchGlyph from '$lib/navigation/SearchGlyph.svelte'
  import { CONTROL_BORDER } from '$lib/components/ui/control-classes.js'

  let { onsearch }: { onsearch?: () => void } = $props()
</script>

<button
  type="button"
  class={`hidden min-w-64 items-center gap-2 rounded-xl border ${CONTROL_BORDER} bg-white px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50 md:flex`}
  aria-label={m.shell_search_field_label()}
  aria-keyshortcuts="Control+K Meta+K"
  data-testid="header-search-field"
  onclick={() => onsearch?.()}
>
  <SearchGlyph />
  <span class="flex-1">{m.shell_search_field_placeholder()}</span>
  <kbd class={`rounded border ${CONTROL_BORDER} px-1 text-xs`} aria-hidden="true">Ctrl K</kbd>
</button>
