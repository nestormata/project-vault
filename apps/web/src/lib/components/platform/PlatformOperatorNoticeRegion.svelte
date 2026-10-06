<script lang="ts">
  import type { Snippet } from 'svelte'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'

  // Story 69.6: the "platform operator access required" notice as one replaceable region; `children`
  // is the region's injection point. The route renders it only for the caller who sees the notice.
  let { children }: { children?: Snippet } = $props()
</script>

<PlatformOperatorRequiredNotice />{@render children?.()}
