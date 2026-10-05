<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="mt-2 text-2xl font-bold text-gray-900">Themes</h1>
<p class="mt-2 text-gray-500">Choose which installed theme is active for your view.</p>
{@render children?.()}
