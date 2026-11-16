<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import HardwareKeysPanel from './HardwareKeysPanel.svelte'

  let { children, ...panel }: ComponentProps<typeof HardwareKeysPanel> & { children?: Snippet } =
    $props()
</script>

<HardwareKeysPanel {...panel} />{@render children?.()}
