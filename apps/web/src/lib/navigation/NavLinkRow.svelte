<!--
  Story 68.7 (S10, S11): a row of sibling sub-section links, separated as main's markup was. A link
  with children becomes a disclosure.
-->
<script lang="ts">
  import NavDisclosure from './NavDisclosure.svelte'
  import NavEntry from './NavEntry.svelte'
  import { renderSurface } from './build-surface.js'

  let {
    surface,
    class: className = 'font-medium text-indigo-600 underline',
  }: { surface: 'platform.settings.links' | 'settings.audit.links'; class?: string } = $props()

  const links = $derived(renderSurface(surface, { pathname: '' }))
  /** The whitespace main's markup had between two links. */
  const GAP = ' '
</script>

{#each links as link, index (link.id)}{#if index > 0}{GAP}{/if}{#if link.children.length > 0}<NavDisclosure
      node={link}
      class={className}
    />{:else}<NavEntry node={link} class={className} />{/if}{/each}
