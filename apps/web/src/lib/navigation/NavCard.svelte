<!--
  Story 68.7 (S8, S9): one index card (a list item), main's markup byte for byte. A card with
  children lists them as a nested list of cards indented under it.
-->
<script lang="ts">
  import NavCards from './NavCards.svelte'
  import NavEntry from './NavEntry.svelte'
  import type { NavNode } from './types.js'

  let { card }: { card: NavNode } = $props()
</script>

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
