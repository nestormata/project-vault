<!--
  @pv-stable: the props contract ({ user }) is final. Story 68.5: the role, org and sign-out
  cluster extracted from AppShell's header so it is individually replaceable by resolved path
  (a composed app can wrap this file through `pv-original:` and add its own header region).
-->
<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { m } from '$lib/paraglide/messages.js'
  import { logout } from '$lib/api/auth.js'

  let { user }: { user: import('$lib/api/auth.js').AuthUser } = $props()

  // Story 28.4 AC2: $derived (not a bare `m.shell_sign_out()` call inline in the template) so this
  // label re-reads the current locale on every reactive update of this component — mirroring
  // PrimaryNav's own nav-item fix. A live Chrome walkthrough of this exact story found that
  // without this, the label stayed English immediately after a same-page, no-reload locale switch
  // (e.g. from Settings → Language) even though the nav bar (already wrapped in $derived) updated
  // correctly in the same click — only a full navigation/reload picked up the new locale. This is
  // the same "resolved once vs. resolved at read time" hazard AC2 already named for the nav.
  // `user` itself (not just m.shell_sign_out()) is read here so this derived has a genuine tracked
  // Svelte dependency: `user` is this component's own reactive prop, sourced from
  // `(app)/+layout.svelte`'s `data.user`, which SvelteKit's `update()` (called by the Settings →
  // Language form after a no-reload setLocale()) refreshes with a new object reference on every
  // call — even when the underlying values are unchanged. `m.shell_sign_out()` itself reads no
  // Svelte-tracked signal at all (Paraglide's locale is a plain cookie read), so a derived over
  // only that call has zero tracked dependencies and would never re-run after the first paint.
  const signOutLabel = $derived(user && m.shell_sign_out())

  async function signOut() {
    try {
      await logout(fetch)
    } catch {
      // A missing/expired session should not trap the user in the app shell.
    }
    await goto(resolve('/login?reason=logged-out'))
  }
</script>

<span>Role: {user.orgRole}</span>
<span class="max-w-full break-all">Org: {user.orgName}</span>
<button
  class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800"
  type="button"
  onclick={signOut}
>
  {signOutLabel}
</button>
