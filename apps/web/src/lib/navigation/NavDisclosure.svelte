<!--
  Story 68.7 AC-3: the nested form of the shell's small surfaces (account, footer, the utility
  cluster) and of the sub-section link rows: a node with children is a native <details>/<summary>
  disclosure (keyboard: Tab focuses, Enter/Space toggles; no custom ARIA) whose panel lists the
  node's own link first, then its children, at any depth.
-->
<script lang="ts">
  import NavEntry from './NavEntry.svelte'
  import NavNodeEntry from './NavNodeEntry.svelte'
  import type { NavNode } from './types.js'

  let { node, class: className }: { node: NavNode; class: string } = $props()
</script>

<details class="relative inline-block">
  <summary class={`cursor-pointer list-none ${className}`}>{node.label}</summary>
  <div
    class="flex flex-col gap-1 py-1 md:absolute md:z-10 md:min-w-40 md:rounded-xl md:border md:border-slate-200 md:bg-white md:p-1 md:shadow-lg"
  >
    {#if node.href !== undefined || node.external !== undefined || node.onSelect !== undefined}
      <NavEntry node={{ ...node, children: [] }} class={className} />
    {/if}
    {#each node.children as child (child.id)}
      <NavNodeEntry node={child} class={className} />
    {/each}
  </div>
</details>
