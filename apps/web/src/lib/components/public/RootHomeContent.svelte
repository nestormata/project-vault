<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<main class="container mx-auto p-8">
  <h1 class="text-4xl font-bold">{m.brand_name()}</h1>
  <p class="mt-4 text-gray-600">{m.shell_brand_tagline()}</p>
</main>
{@render children?.()}
