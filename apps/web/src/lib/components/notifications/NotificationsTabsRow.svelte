<script lang="ts">
  import type { Snippet } from 'svelte'
  import NavTabs from '$lib/navigation/NavTabs.svelte'

  let { status, children }: { status: 'all' | 'unread' | 'read'; children?: Snippet } = $props()
</script>

<div class="mb-6 flex gap-1 border-b border-gray-200">
  <NavTabs {status} />
</div>
{@render children?.()}
