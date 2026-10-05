<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="text-lg font-semibold text-slate-950">Shared secret</h1>
{@render children?.()}
