<!--
  Story 68.7 (S8 settings index, S9 platform index): a section index as cards (title, description,
  arrow). A card with children lists them as a nested list of cards indented under it, at any
  depth. The markup of a card is main's, byte for byte.
-->
<script lang="ts">
  import NavCards from './NavCards.svelte'
  import NavEntry from './NavEntry.svelte'
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
  {#each cards as card, index (card.id)}{#if index > 0}{GAP}{/if}
    <li>
      <NavEntry node={card} class="flex items-center justify-between px-6 py-4 hover:bg-gray-50">
        <div>
          <p class="font-medium text-gray-900">{card.label}</p>
          <p class="text-sm text-gray-500">{card.description}</p>
        </div>
        <span class="text-gray-400">→</span>
      </NavEntry>{#if card.children.length > 0}<NavCards
          nodes={card.children}
          class="ml-6 divide-y divide-gray-200 border-l border-gray-200"
        />{/if}
    </li>
  {/each}
</ul>
