<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="text-2xl font-bold text-gray-900">Access Report</h1>
<p class="mt-2 text-gray-500">Who had access, as of any point in time.</p>
{@render children?.()}
