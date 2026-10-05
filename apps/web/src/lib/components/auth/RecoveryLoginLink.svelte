<script lang="ts">
  import type { Snippet } from 'svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'

  let { children }: { children?: Snippet } = $props()
</script>

{@render children?.()}
<p class="text-sm text-slate-600">
  Remembered your password? <NavLink
    surface="auth.links"
    node="auth.links.recovery.login"
    class="font-medium text-brand-600 underline"
  />
</p>
