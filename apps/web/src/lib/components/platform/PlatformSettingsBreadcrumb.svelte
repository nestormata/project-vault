<script lang="ts">
  import PlatformBreadcrumb from './PlatformBreadcrumb.svelte'
  import type { Snippet } from 'svelte'
  import type { PlatformPath } from '$lib/app-paths.js'

  interface Props {
    allowed: boolean
    /** The leaf of a fixed Platform Admin › System Settings › leaf trail (existing callers). */
    leafLabel?: string
    /** Story 68.7: the page's node in the `breadcrumbs` nav tree (nav as data). */
    node?: string
    maxWidth?: string
    children: Snippet
  }

  let { allowed, leafLabel = '', node, maxWidth = 'max-w-4xl', children }: Props = $props()

  // Story 68.1 AC-3: $derived so the leaf follows a new `leafLabel` on the same instance.
  const trail: { label: string; href?: PlatformPath }[] = $derived([
    { label: 'Platform Admin', href: '/platform' },
    { label: 'System Settings', href: '/platform/settings' },
    { label: leafLabel },
  ])
</script>

<PlatformBreadcrumb {allowed} trail={node === undefined ? trail : []} {node} {maxWidth}>
  {@render children()}
</PlatformBreadcrumb>
