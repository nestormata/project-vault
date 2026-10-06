<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'

  // Story 69.6: the status page admin screen's error alert as one replaceable region; `children` is
  // the region's injection point.
  let { children, ...alert }: ComponentProps<typeof MfaAwareErrorAlert> & { children?: Snippet } =
    $props()
</script>

<MfaAwareErrorAlert {...alert} />{@render children?.()}
