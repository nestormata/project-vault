<script lang="ts">
  import type { Snippet } from 'svelte'
  import NavigationProgressBar from '$lib/components/NavigationProgressBar.svelte'

  // Story 69.6: the navigation progress bar of the root layout as one replaceable region;
  // `children` is the region's injection point.
  let { children }: { children?: Snippet } = $props()
</script>

<NavigationProgressBar />{@render children?.()}
