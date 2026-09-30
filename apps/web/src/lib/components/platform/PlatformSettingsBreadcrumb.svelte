<script lang="ts">
  import PlatformBreadcrumb from './PlatformBreadcrumb.svelte'
  import type { Snippet } from 'svelte'
  import type { PlatformPath } from '$lib/app-paths.js'

  interface Props {
    allowed: boolean
    leafLabel: string
    maxWidth?: string
    children: Snippet
  }

  let { allowed, leafLabel, maxWidth = 'max-w-4xl', children }: Props = $props()

  // Story 68.1 AC-3: $derived so the leaf follows a new `leafLabel` on the same instance.
  const trail: { label: string; href?: PlatformPath }[] = $derived([
    { label: 'Platform Admin', href: '/platform' },
    { label: 'System Settings', href: '/platform/settings' },
    { label: leafLabel },
  ])
</script>

<PlatformBreadcrumb {allowed} {trail} {maxWidth}>
  {@render children()}
</PlatformBreadcrumb>
