<script lang="ts">
  import PlatformBreadcrumb from './PlatformBreadcrumb.svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    allowed: boolean
    leafLabel: string
    maxWidth?: string
    children: Snippet
  }

  let { allowed, leafLabel, maxWidth = 'max-w-4xl', children }: Props = $props()

  const trail = [
    { label: 'Platform Admin', href: '/platform' },
    { label: 'System Settings', href: '/platform/settings' },
    { label: leafLabel },
  ]
</script>

<PlatformBreadcrumb {allowed} {trail} {maxWidth}>
  {@render children()}
</PlatformBreadcrumb>
