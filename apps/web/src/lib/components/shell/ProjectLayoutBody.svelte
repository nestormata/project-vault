<script lang="ts">
  import type { Snippet } from 'svelte'

  // Story 69.6: the routed page of the project layout as one replaceable region. `body` is the
  // layout's own `children` (the project page); `children` is the region's injection point.
  let { body, children }: { body: Snippet; children?: Snippet } = $props()
</script>

{@render children?.()}{@render body()}
