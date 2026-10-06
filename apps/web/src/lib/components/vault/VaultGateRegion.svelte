<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import VaultGate from './VaultGate.svelte'

  // Story 69.6: the vault init/unseal gate as one replaceable region; `children` is the region's
  // injection point, rendered right after the gate.
  let { children, ...gate }: ComponentProps<typeof VaultGate> & { children?: Snippet } = $props()
</script>

<VaultGate {...gate} />{@render children?.()}
