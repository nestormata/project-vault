<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import NavCards from '$lib/navigation/NavCards.svelte'

  // Story 69.6: a landing page's nav cards (settings home, platform home) as one replaceable region;
  // `children` is the page's own injection point for that region.
  let {
    surface,
    children,
  }: { surface: NonNullable<ComponentProps<typeof NavCards>['surface']>; children?: Snippet } =
    $props()
</script>

<NavCards {surface} />{@render children?.()}
