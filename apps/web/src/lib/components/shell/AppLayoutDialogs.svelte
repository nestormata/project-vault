<script lang="ts">
  import type { Snippet } from 'svelte'
  import ConfirmDialogHost from '$lib/components/ui/ConfirmDialogHost.svelte'

  // Epic 72 fix: the app-wide dialog hosts as one replaceable region. `children` is the region's
  // injection point, rendered after the hosts without adding a DOM node (the hosts render nothing
  // while idle).
  let { children }: { children?: Snippet } = $props()
</script>

<ConfirmDialogHost />{@render children?.()}
