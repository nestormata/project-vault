<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div>
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New certificate</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Add certificate</h1>
</div>
{@render children?.()}
