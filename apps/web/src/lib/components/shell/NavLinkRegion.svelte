<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'

  // Story 69.6: a page's back link (the `back` nav surface) as one replaceable region; `children` is
  // the page's own injection point for that region.
  let { children, ...link }: ComponentProps<typeof NavLink> & { children?: Snippet } = $props()
</script>

<NavLink {...link} />{@render children?.()}
