<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import MfaEnrollmentPanel from './MfaEnrollmentPanel.svelte'

  // Story 69.6: the MFA enrollment panel of the security page as one replaceable region; `children`
  // is the region's injection point. The panel keeps its own enrollment state.
  let { children, ...panel }: ComponentProps<typeof MfaEnrollmentPanel> & { children?: Snippet } =
    $props()
</script>

<MfaEnrollmentPanel {...panel} />{@render children?.()}
