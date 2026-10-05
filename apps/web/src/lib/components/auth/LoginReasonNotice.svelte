<script lang="ts">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import { m } from '$lib/paraglide/messages.js'

  let { children }: { children?: Snippet } = $props()

  function localizedReasonMessage(reason: string | null) {
    switch (reason) {
      case 'registered':
        return m.auth_login_reason_registered()
      case 'session-expired':
        return m.auth_login_reason_session_expired()
      case 'logged-out':
        return m.auth_login_reason_logged_out()
      case 'recovery-complete':
        return m.auth_login_reason_recovery_complete()
      default:
        return m.auth_login_reason_default()
    }
  }

  const message = $derived(localizedReasonMessage(page.url.searchParams.get('reason')))
</script>

<p class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
  {message}
</p>
{@render children?.()}
