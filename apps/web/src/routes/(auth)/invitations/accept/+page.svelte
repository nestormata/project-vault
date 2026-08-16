<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { getCurrentUser } from '$lib/api/auth.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { acceptInvitation, peekInvitation, type InvitationPeek } from '$lib/api/invitations.js'
  import { m } from '$lib/paraglide/messages.js'
  import { setPreAuthTheme } from '$lib/state/theme.svelte.js'
  import { resolvePreAuthTheme } from '$lib/components/auth/form-model.js'

  // Story 23.2 AC-6c: 'external-signin' is the honest G3 "no dead ends" state for an
  // account-less invitee on an instance where native login is excluded — reached INSTEAD OF the
  // automatic navigation to /register below, never in addition to it, and never a "create your
  // account" link that would land on a 403ing form.
  let status = $state<'loading' | 'invalid' | 'error' | 'external-signin'>('loading')
  let invalidReason = $state('')
  let loginHref = $state('/login')

  async function run() {
    const token = page.url.searchParams.get('token')
    if (!token) {
      status = 'invalid'
      invalidReason = 'This invitation link is missing a token.'
      return
    }

    let peek: InvitationPeek
    try {
      peek = await peekInvitation(fetch, token)
    } catch (error) {
      status = 'invalid'
      invalidReason =
        error instanceof ApiClientError
          ? 'This invitation link is no longer valid.'
          : 'Something went wrong loading this invitation.'
      return
    }

    // Story 16.5 AC-3/Task 2.2/Pre-Mortem #1: fire-and-forget, best-effort branding lookup for the
    // now-known invitation email — deliberately NOT awaited before either goto() branch below, so
    // a slow, hung, or failing lookup can never delay or break this function's own accept/redirect
    // flow. `resolvePreAuthTheme` already fails open internally (never rejects), and the trailing
    // `.catch()` is an extra, deliberately redundant safety net so nothing here can ever throw
    // into this function's own control flow.
    void resolvePreAuthTheme(fetch, peek.email)
      .then((theme) => setPreAuthTheme(theme.name, theme.css))
      .catch(() => {})

    if (!peek.accountExists) {
      // Story 23.2 AC-16: fail-safe default — an absent/undefined field (an older cached
      // response shape, or a test double that doesn't set it) is treated as enabled, the
      // byte-identical-to-today direction, never as excluded.
      if (peek.nativeLoginEnabled === false) {
        // AC-6c: this vault has no native /register to send an account-less invitee to — that
        // would be a dead end (a 403 on submit). Show the honest external-sign-in state with a
        // working link back into /login (which already resolves the SSO/placeholder split for
        // whatever email they type — AC-13), carrying `next` so a successful sign-in returns
        // here and accepts the invitation normally.
        const next = `/invitations/accept?token=${encodeURIComponent(token)}`
        loginHref = `/login?next=${encodeURIComponent(next)}`
        status = 'external-signin'
        return
      }
      const params = new URLSearchParams({ invitationToken: token, email: peek.email })
      // Dynamic query string, not a literal resolve() can type-check at compile time.
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(`/register?${params.toString()}`)
      return
    }

    try {
      await getCurrentUser(fetch)
    } catch {
      const next = `/invitations/accept?token=${encodeURIComponent(token)}`
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(`/login?next=${encodeURIComponent(next)}`)
      return
    }

    try {
      const result = await acceptInvitation(fetch, token)
      await goto(resolve(`/projects/${result.projectId}`))
    } catch {
      status = 'error'
    }
  }

  onMount(() => {
    void run()
  })
</script>

<svelte:head>
  <title>Accept invitation | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  {#if status === 'loading'}
    <p class="text-slate-600">Checking your invitation...</p>
  {:else if status === 'invalid'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Invitation not available</h1>
      <p class="text-slate-600">{invalidReason}</p>
    </div>
  {:else if status === 'error'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Something went wrong</h1>
      <p class="text-slate-600">We couldn't accept this invitation. Please try again.</p>
    </div>
  {:else if status === 'external-signin'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">{m.invitations_accept_external_signin_heading()}</h1>
      <p class="text-slate-600">{m.invitations_accept_external_signin_description()}</p>
      <!-- Dynamic href built from the invitation token, not a literal resolve() can type-check. -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={loginHref} class="text-sm font-medium text-blue-600 hover:underline">
        {m.invitations_accept_external_signin_link()}
      </a>
    </div>
  {/if}
</div>
