<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import LoginForm from '$lib/components/auth/LoginForm.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Only allow same-origin relative paths — a bare "/x" is safe, "//evil.com" or an absolute
  // URL is not (browsers treat "//" as protocol-relative, i.e. an external redirect).
  function safeNextPath(raw: string | null): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
    return raw
  }

  // Story 23.2 AC-13: `data.nativeLoginEnabled` defaults to `true` when the prop itself is
  // absent (existing tests that render this page without SvelteKit's load — byte-identical to
  // today, AC-16) — `null` (the load's own cold-start-failure signal) is preserved as-is.
  let { data = { nativeLoginEnabled: true } }: { data?: { nativeLoginEnabled: boolean | null } } =
    $props()

  let localeRevision = $state(0)
  let nextPath = $derived(safeNextPath(page.url.searchParams.get('next')))
  let pageTitle = $derived(
    localeRevision === 0 ? m.auth_login_page_title() : m.auth_login_page_title()
  )

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

  function handleLocaleChange() {
    localeRevision += 1
  }
</script>

<div class="space-y-6">
  {#key localeRevision}
    <div class="space-y-2">
      <h1 class="text-3xl font-bold">{m.auth_login_page_heading()}</h1>
      <p class="text-slate-600">{m.auth_login_page_description()}</p>
    </div>
    {@const message = localizedReasonMessage(page.url.searchParams.get('reason'))}
    <p class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      {message}
    </p>
    {#if data.nativeLoginEnabled === true}
      <!-- Story 23.2 AC-13: Register/Recovery links only ever lead to native-credential flows
      (AC-6 rows #1/#5) — never rendered when native login is disabled or its status is unknown. -->
      <p class="text-sm text-slate-600">
        {m.auth_login_register_prompt()}
        <a class="font-medium text-brand-600 underline" href={resolve('/register')}
          >{m.auth_login_register_link()}</a
        >
      </p>
      <p class="text-sm text-slate-600">
        <a class="font-medium text-brand-600 underline" href={resolve('/recovery')}
          >{m.auth_login_recovery_link()}</a
        >
      </p>
    {/if}
  {/key}
  {#if data.nativeLoginEnabled === null}
    <!-- Story 23.2 AC-13: cold-start health-check failure with no last-known-good cache — a
    neutral, retryable state, never a password form rendered on a guess. -->
    <div class="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p class="text-sm text-slate-700">{m.auth_login_temporarily_unavailable()}</p>
      <button
        class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
        type="button"
        onclick={() => window.location.reload()}
      >
        {m.auth_login_retry()}
      </button>
    </div>
  {:else}
    <LoginForm
      {nextPath}
      onLocaleChange={handleLocaleChange}
      nativeLoginEnabled={data.nativeLoginEnabled}
    />
  {/if}
</div>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>
