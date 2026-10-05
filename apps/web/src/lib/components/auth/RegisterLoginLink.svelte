<script lang="ts">
  import type { Snippet } from 'svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'
  import { m } from '$lib/paraglide/messages.js'

  let { children }: { children?: Snippet } = $props()
</script>

{@render children?.()}
<p class="text-sm text-slate-600">
  {m.auth_register_existing_account_prompt()}
  <NavLink
    surface="auth.links"
    node="auth.links.register.login"
    class="font-medium text-brand-600 underline"
  />
</p>
