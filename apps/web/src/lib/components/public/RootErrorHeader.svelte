<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<header class="border-b border-slate-200 bg-white">
  <div class="mx-auto max-w-7xl px-4 py-4">
    <p class="text-xl font-bold text-brand-600">{m.brand_name()}</p>
  </div>
</header>
{@render children?.()}
