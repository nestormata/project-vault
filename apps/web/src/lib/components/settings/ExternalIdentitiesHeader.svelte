<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="text-2xl font-bold text-gray-900">External Identities</h1>
<p class="mt-2 text-gray-500">
  See which org members have a linked external identity for SSO sign-in, link a new one, or unlink a
  stale one.
</p>
{@render children?.()}
