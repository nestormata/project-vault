<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="text-2xl font-bold text-gray-900">Settings</h1>
<p class="mt-2 text-gray-500">Manage your vault preferences.</p>
{@render children?.()}
