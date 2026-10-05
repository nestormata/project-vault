<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="text-2xl font-bold text-gray-900">Users</h1>
<p class="mt-2 text-gray-500">Manage everyone across your organization and their project roles.</p>
{@render children?.()}
