<!--
  @pv-stable: the props contract ({ node } or { trail }) is final. Story 68.7 (S13, design rule 8):
  breadcrumbs from the `breadcrumbs` tree. A page passes its own node id and gets the path from the
  root to it (the last crumb is text); a CM page shows PV's breadcrumbs after inserting its own
  node. `trail` renders a fixed trail instead (PlatformBreadcrumb's existing prop).
-->
<script lang="ts">
  import type { ResolvedPathname } from '$app/types'
  import NavEntry from './NavEntry.svelte'
  import { findNodePath, renderSurface } from './build-surface.js'
  import type { NavNode } from './types.js'

  interface Crumb {
    id: string
    label: string
    href?: ResolvedPathname
    node?: NavNode
  }

  let {
    node,
    trail = [],
    spacing = 'after',
  }: {
    node?: string
    trail?: { label: string; href?: ResolvedPathname }[]
    /** Where the whitespace between crumbs goes: `after` each separator (PlatformBreadcrumb's
     * markup on main) or `around` it (the platform settings and upgrade pages' markup on main). */
    spacing?: 'after' | 'around'
  } = $props()

  const GAP = ' '

  const crumbs: Crumb[] = $derived.by(() => {
    if (node === undefined) return trail.map((crumb, index) => ({ id: `${index}`, ...crumb }))
    const path = findNodePath(renderSurface('breadcrumbs', { pathname: '', node }), node) ?? []
    return path.map((entry) => ({ id: entry.id, label: entry.label, node: entry }))
  })
</script>

{#if crumbs.length > 0}
  <nav class="mb-4 text-sm text-gray-500">
    {#each crumbs as crumb, i (crumb.id)}
      {#if spacing === 'around'}{#if i > 0}{GAP}<span class="mx-2">›</span
          >{GAP}{/if}{:else}{#if i > 0}<span class="mx-2">›</span
          >{/if}{GAP}{/if}{#if crumb.node !== undefined && i < crumbs.length - 1}
        <NavEntry node={crumb.node} class="hover:underline" />
      {:else if crumb.node === undefined && crumb.href !== undefined}
        <a href={crumb.href} class="hover:underline">{crumb.label}</a>
      {:else}
        <span>{crumb.label}</span>
      {/if}
    {/each}
  </nav>
{/if}
