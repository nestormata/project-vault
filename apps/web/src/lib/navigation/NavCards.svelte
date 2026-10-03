<!--
  Story 68.7 (S8 settings index, S9 platform index): a section index as a list of cards (title,
  description, arrow), at any depth (NavCard nests a card's children as a list under it).
-->
<script lang="ts">
  import NavCard from './NavCard.svelte'
  import { renderSurface } from './build-surface.js'
  import type { NavNode } from './types.js'

  let {
    surface,
    nodes,
    class: className = 'mt-8 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white',
  }: {
    surface?: 'settings.index' | 'platform.index'
    /** A subtree to render (the nested form); otherwise the surface's items. */
    nodes?: NavNode[]
    class?: string
  } = $props()

  /** The whitespace main's markup had between two cards. */
  const GAP = ' '
  const cards = $derived(
    nodes ?? (surface === undefined ? [] : renderSurface(surface, { pathname: '' }))
  )
</script>

<ul class={className}>
  {#each cards as card, index (card.id)}{#if index > 0}{GAP}{/if}<NavCard {card} />{/each}
</ul>
