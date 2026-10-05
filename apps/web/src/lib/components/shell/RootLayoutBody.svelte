<script lang="ts">
  import type { Snippet } from 'svelte'

  // Story 69.5: the page content of the root layout as one replaceable region. `body` is the
  // layout's own `children` (the routed page); `children` is the region's injection point.
  let { body, children }: { body: Snippet; children?: Snippet } = $props()
</script>

{@render children?.()}
{@render body()}
