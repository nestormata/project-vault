<script lang="ts">
  import { resolve } from '$app/paths'
  import type { PlatformPath } from '$lib/app-paths.js'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import Breadcrumbs from '$lib/navigation/Breadcrumbs.svelte'
  import type { Snippet } from 'svelte'

  interface Crumb {
    label: string
    href?: PlatformPath
  }

  interface Props {
    allowed: boolean
    /** A fixed trail (kept for existing callers); PV's pages pass `node` instead. */
    trail?: Crumb[]
    /** Story 68.7: the page's node in the `breadcrumbs` nav tree (nav as data). */
    node?: string
    maxWidth?: string
    children: Snippet
  }

  let { allowed, trail = [], node, maxWidth = 'max-w-5xl', children }: Props = $props()

  const resolvedTrail = $derived(
    trail.map((crumb) =>
      crumb.href === undefined
        ? { label: crumb.label }
        : { label: crumb.label, href: resolve(crumb.href) }
    )
  )
</script>

{#if !allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class={`mx-auto ${maxWidth} px-4 py-8`}>
    <Breadcrumbs {node} trail={resolvedTrail} />
    {@render children()}
  </div>
{/if}
