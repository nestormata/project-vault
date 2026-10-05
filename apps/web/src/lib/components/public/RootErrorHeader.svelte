<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<header class="border-b border-slate-200 bg-white">
  <div class="mx-auto max-w-7xl px-4 py-4">
    <p class="text-xl font-bold text-brand-600">Project Vault</p>
  </div>
</header>
{@render children?.()}
