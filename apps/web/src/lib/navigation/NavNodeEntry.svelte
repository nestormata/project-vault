<!--
  Story 68.7: one node of a small surface: a disclosure when it has children (at any depth), else
  the plain entry. The shared nested form of the account menu, the utility cluster, the footer and
  the link rows.
-->
<script lang="ts">
  import NavDisclosure from './NavDisclosure.svelte'
  import NavEntry from './NavEntry.svelte'
  import type { NavNode } from './types.js'

  let { node, class: className }: { node: NavNode; class: string } = $props()
</script>

{#if node.children.length > 0}<NavDisclosure {node} class={className} />{:else}<NavEntry
    {node}
    class={className}
  />{/if}
