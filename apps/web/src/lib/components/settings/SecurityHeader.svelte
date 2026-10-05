<script lang="ts">
  import type { Snippet } from 'svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div class="mb-8">
  <NavLink
    surface="back"
    node="back.settings.security"
    class="text-sm text-indigo-600 hover:text-indigo-800"
  />
  <h1 class="mt-2 text-2xl font-bold text-gray-900">Security</h1>
  <p class="text-gray-500">Manage multi-factor authentication for your account.</p>
</div>
{@render children?.()}
