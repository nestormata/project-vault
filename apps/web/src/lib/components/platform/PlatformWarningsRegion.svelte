<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import PlatformWarningsBanner from './PlatformWarningsBanner.svelte'

  // Story 69.6: the platform home's warnings banner as one replaceable region; `children` is the
  // region's injection point.
  let {
    children,
    ...banner
  }: ComponentProps<typeof PlatformWarningsBanner> & { children?: Snippet } = $props()
</script>

<PlatformWarningsBanner {...banner} />{@render children?.()}
