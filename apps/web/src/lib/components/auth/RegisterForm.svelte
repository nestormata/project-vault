<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { register } from '$lib/api/auth.js'
  import { setPreAuthTheme } from '$lib/state/theme.svelte.js'
  import {
    buildRegisterRequest,
    clearRegisterFields,
    getPostRegisterPath,
    resolvePreAuthTheme,
  } from './form-model.js'

  let { invitationToken, prefillEmail = '' }: { invitationToken?: string; prefillEmail?: string } =
    $props()

  let email = $state(prefillEmail)
  let password = $state('')
  let orgName = $state('')
  let errorMessage = $state(null)
  let emailInputEl: HTMLInputElement | undefined = $state()

  // Story 16.5 AC-1/AC-2/AC-8: tracks which email a background theme lookup is currently in
  // flight for, mirroring `LoginForm`'s `pendingLookupEmail` race guard — but, unlike
  // `LoginForm`'s Step-A "Continue" button, this state is purely cosmetic bookkeeping and must
  // NEVER gate, disable, or delay the "Create account" submit button or `submitForm()` itself
  // (Pre-Mortem #4): registration must succeed identically whether a theme lookup is still in
  // flight, has failed, or was never triggered at all.
  let pendingThemeLookupEmail = $state<string | null>(null)

  // Story 16.5 Task 1.2: resolves and applies org branding for `candidateEmail`, discarding the
  // response if the current `email` has since changed away from it (out-of-order race guard,
  // identical in shape to `LoginForm`'s `submitEmailStep()` guard). Gated on basic HTML5 email
  // validity (via the input element's own `checkValidity()`) so an obviously-invalid or empty
  // string never spends a lookup call.
  async function applyThemeForEmail(candidateEmail: string) {
    if (!candidateEmail) return
    if (emailInputEl && !emailInputEl.checkValidity()) return
    pendingThemeLookupEmail = candidateEmail
    const theme = await resolvePreAuthTheme(fetch, candidateEmail)
    if (email === candidateEmail) {
      setPreAuthTheme(theme.name, theme.css)
    }
    if (pendingThemeLookupEmail === candidateEmail) pendingThemeLookupEmail = null
  }

  // Story 16.5 AC-2/Task 1.4: the invitation flow's email is pre-filled and read-only, so it will
  // never receive a blur event from the user — resolve its branding once on mount instead. Does
  // not fire for the non-invitation path (no `invitationToken`, nothing to resolve yet).
  onMount(() => {
    if (invitationToken && prefillEmail) {
      void applyThemeForEmail(prefillEmail)
    }
  })

  function clearFields() {
    const cleared = clearRegisterFields({ email, password, orgName })
    email = invitationToken ? prefillEmail : cleared.email
    password = cleared.password
    orgName = cleared.orgName
  }

  async function submitForm() {
    errorMessage = null
    try {
      const result = await register(
        fetch,
        buildRegisterRequest({ email, password, orgName, invitationToken })
      )
      clearFields()
      // getPostRegisterPath() returns either a static route or a server-issued project id —
      // not a literal resolve() can type-check at compile time.
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(getPostRegisterPath(result.invitedProject))
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Registration failed.'
      password = ''
    }
  }
</script>

<form
  class="space-y-5"
  onsubmit={(event) => {
    event.preventDefault()
    void submitForm()
  }}
>
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="register-email">Email</label>
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="register-email"
      type="email"
      bind:value={email}
      bind:this={emailInputEl}
      readonly={Boolean(invitationToken)}
      required
      onblur={() => void applyThemeForEmail(email)}
    />
  </div>
  {#if !invitationToken}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="register-org">Organization name</label>
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="register-org"
        type="text"
        bind:value={orgName}
        maxlength="128"
        required
      />
    </div>
  {/if}
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="register-password">Password</label>
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="register-password"
      type="password"
      autocomplete="new-password"
      bind:value={password}
      minlength="12"
      required
    />
    <p class="text-sm text-slate-600">Use at least 12 characters.</p>
  </div>
  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}
  <button
    class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
    type="submit">Create account</button
  >
</form>
