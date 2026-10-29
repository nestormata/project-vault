<script lang="ts">
  import type { Snippet } from 'svelte'
  import ConfirmDialogHost from '$lib/components/ui/ConfirmDialogHost.svelte'
  import ShortcutsDialogHost from './ShortcutsDialogHost.svelte'

  // Epic 72 fix: the two app-wide dialog hosts (72-5 confirm, 72-6 shortcuts) as one replaceable
  // region. `children` is the region's injection point, rendered after the hosts without adding a
  // DOM node (the hosts render nothing while idle).
  let { children }: { children?: Snippet } = $props()
</script>

<ConfirmDialogHost /><ShortcutsDialogHost />{@render children?.()}
