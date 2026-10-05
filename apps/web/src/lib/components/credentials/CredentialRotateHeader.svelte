<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div>
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Rotation</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Start rotation</h1>
</div>
{@render children?.()}
