<!--
  Story 68.7 (S14 back links, S16 auth cross-links): one node of a single-link surface, rendered
  with the page's own classes, its children as sibling links after it. Renders nothing when a
  delta removed or hid the node (or a `when` hides it). Reusable by CM pages (design rule 8).
-->
<script lang="ts">
  import NavEntry from './NavEntry.svelte'
  import { findNodePath, renderSurface, withDescendants } from './build-surface.js'

  let {
    node,
    surface,
    class: className,
    projectId = '',
    credentialId = '',
  }: {
    node: string
    surface: 'back' | 'auth.links'
    class: string
    projectId?: string
    credentialId?: string
  } = $props()

  // These surfaces mark no current item, so the path is not needed (and pages that render them
  // need no `$app/state`).
  const nodes = $derived.by(() => {
    const pathname = ''
    const rendered =
      surface === 'back'
        ? renderSurface('back', { pathname, projectId, credentialId })
        : renderSurface('auth.links', { pathname })
    const found = findNodePath(rendered, node)?.at(-1)
    return found === undefined ? [] : withDescendants(found)
  })
</script>

{#each nodes as entry (entry.id)}<NavEntry node={entry} class={className} />{/each}
