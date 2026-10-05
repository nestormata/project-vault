<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<main class="container mx-auto p-8">
  <h1 class="text-4xl font-bold">Project Vault</h1>
  <p class="mt-4 text-gray-600">Run complex projects. Miss nothing.</p>
</main>
{@render children?.()}
