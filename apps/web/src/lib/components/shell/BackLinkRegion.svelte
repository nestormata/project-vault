<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import BackLink from '$lib/components/monitoring/BackLink.svelte'

  // Story 69.6: a monitoring page's back link as one replaceable region; `children` is the page's own
  // injection point for that region.
  let { children, ...link }: ComponentProps<typeof BackLink> & { children?: Snippet } = $props()
</script>

<BackLink {...link} />{@render children?.()}
