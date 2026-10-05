<script lang="ts">
  import type { Snippet } from 'svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'
  import { m } from '$lib/paraglide/messages.js'

  let { nativeLoginEnabled, children }: { nativeLoginEnabled: boolean | null; children?: Snippet } =
    $props()
</script>

{@render children?.()}
{#if nativeLoginEnabled === true}
  <!-- Story 23.2 AC-13: Register/Recovery links only ever lead to native-credential flows
  (AC-6 rows #1/#5) — never rendered when native login is disabled or its status is unknown. -->
  <p class="text-sm text-slate-600">
    {m.auth_login_register_prompt()}
    <NavLink
      surface="auth.links"
      node="auth.links.login.register"
      class="font-medium text-brand-600 underline"
    />
  </p>
  <p class="text-sm text-slate-600">
    <NavLink
      surface="auth.links"
      node="auth.links.login.recovery"
      class="font-medium text-brand-600 underline"
    />
  </p>
{/if}
