<script lang="ts">
  import type { Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'

  let { children }: { children?: Snippet } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <h1 class="text-3xl font-bold text-slate-950">{m.shares_index_heading()}</h1>
  <p class="mt-2 text-slate-600">{m.shares_index_intro()}</p>
</div>
{@render children?.()}
