<!--
  Story 68.7: one nav node as an interactive element, for renderers whose markup has no
  item-specific structure: an external link (new tab, `noopener noreferrer`), an internal link, an
  action button or, for a group without its own link, plain text. Its attributes are all derived
  from the node, so their order is the same as the hand-written markup it replaced. It never sets
  `aria-current`: that belongs to the registered surface renderer that knows what "current" means.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { NavNode } from './types.js'

  let {
    node,
    class: className,
    children,
  }: { node: NavNode; class: string; children?: Snippet } = $props()
</script>

{#snippet content()}{#if children}{@render children()}{:else}{#if node.icon}<node.icon
      />{/if}{node.label}{/if}{/snippet}
{#if node.external}
  <a
    href={`${node.external.scheme}://${node.external.rest}`}
    target={node.external ? '_blank' : undefined}
    rel={node.external ? 'noopener noreferrer' : undefined}
    class={className}>{@render content()}</a
  >
{:else if node.href !== undefined}
  <a class={className} href={node.href}>{@render content()}</a>
{:else if node.onSelect}
  <button class={className} type="button" onclick={() => node.onSelect?.()}
    >{@render content()}</button
  >
{:else}
  <span class={className}>{@render content()}</span>
{/if}
