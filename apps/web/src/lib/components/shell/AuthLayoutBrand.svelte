<script lang="ts">
  import type { Snippet } from 'svelte'
  import AuthBrandHeader from './AuthBrandHeader.svelte'

  // Story 69.6: the brand header of the pre-auth layout as one replaceable region; `children` is the
  // region's injection point.
  let { children }: { children?: Snippet } = $props()
</script>

<AuthBrandHeader />{@render children?.()}
