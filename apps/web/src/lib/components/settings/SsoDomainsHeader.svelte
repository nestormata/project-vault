<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="text-2xl font-bold text-gray-900">SSO Domains</h1>
<p class="mt-2 text-gray-500">
  Route email domains to an SSO provider so people at that domain sign in through it instead of a
  password.
</p>
{@render children?.()}
