<script lang="ts">
  import { goto } from '$app/navigation'
  import { getCurrentUser, login, lookupSsoDomain, ssoCallback, ssoStart } from '$lib/api/auth.js'
  import { setPreAuthTheme, writePreAuthThemeCache } from '$lib/state/theme.svelte.js'
  import {
    buildDomainLookupRequest,
    buildLoginRequest,
    clearLoginFields,
    isMfaChallenge,
    isSsoRequired,
    normalizePreAuthTheme,
  } from './form-model.js'
  import MfaLoginForm from './MfaLoginForm.svelte'

  let { nextPath = '/dashboard' }: { nextPath?: string } = $props()

  // Story 14.4 Task 3.1: two-step, email-first flow. 'email' is Step A (email + Continue);
  // 'password' and 'sso' are the two possible Step B outcomes of the domain-lookup call — never
  // both shown at once, and never chosen without the lookup actually running (AC-4).
  let step = $state<'email' | 'password' | 'sso'>('email')

  let email = $state('')
  let password = $state('')
  let ssoProviderName = $state<string | null>(null)
  let ssoCredential = $state('')
  let mfaToken = $state(null)
  let statusMessage = $state(null)
  let errorMessage = $state(null)
  let isSubmitting = $state(false)
  // Story 14.4 AC-8/AC-11: tracks which email a domain-lookup is currently in flight for.
  // Distinct from `isSubmitting` (used by the password/SSO steps' single-request guard) because
  // Step A must allow a *new* lookup the moment the user edits the email away from the one a
  // pending request was issued for (AC-8's "user changes their mind" scenario), while still
  // blocking an exact re-submit of the same in-flight email (AC-11's double-click guard).
  let pendingLookupEmail = $state<string | null>(null)

  function clearFields() {
    const cleared = clearLoginFields({ email, password })
    email = cleared.email
    password = cleared.password
  }

  async function completeSession() {
    await getCurrentUser(fetch)
    clearFields()
    // nextPath is a caller-supplied, same-origin-only redirect target (see safeNextPath() in
    // the login page) — not a static route resolve() can type-check at compile time.
    // eslint-disable-next-line svelte/no-navigation-without-resolve
    await goto(nextPath)
  }

  // Story 14.4 AC-8: guards the out-of-order-response race — keys the async lookup to the email
  // value at call time, and ignores the response (never applies it to UI state) if the current
  // input has since changed to something else, no matter which of two in-flight calls resolves
  // first.
  async function submitEmailStep() {
    // AC-11: blocks an exact re-submit of the email a lookup is already running for.
    if (pendingLookupEmail === email) return
    errorMessage = null
    statusMessage = null
    const requestEmail = email
    pendingLookupEmail = requestEmail
    try {
      const result = await lookupSsoDomain(fetch, buildDomainLookupRequest(requestEmail).email)
      if (email !== requestEmail) return
      // Story 16.4 AC-3: apply (or clear) the resolved org theme BEFORE flipping `step`, so the
      // branding is already in place the moment Step B (password/SSO) renders — never a visible
      // flash of base-theme-then-branded. `theme` is absent/null on every miss/orphan/error path
      // (AC-3's both-or-neither invariant), which this always-call resets back to the base theme.
      // Story 16.5 Task 0.2: the theme-shape normalization is now shared with `RegisterForm`'s
      // and `invitations/accept`'s own resolvers via `normalizePreAuthTheme` — this still calls
      // `lookupSsoDomain()` directly (rather than the sibling `resolvePreAuthTheme` helper) since
      // it also needs the raw response's `ssoRequired`/`providerName` fields to pick the next
      // step, and a second lookup call just to reuse that helper would double this form's request
      // volume per submission (a real behavior change, not a pure refactor).
      const theme = normalizePreAuthTheme(result)
      setPreAuthTheme(theme.name, theme.css)
      // Story 16.6 AC-1/AC-3: this call site bypasses `resolvePreAuthTheme()` (see the comment
      // above), so it must call the cache write-through directly rather than relying on that
      // helper's own write — confirmed missing and fixed during this story's own Chrome
      // verification pass (Task 2.2's original review incorrectly reported no bypass existed).
      // Same AC-3 guard as `resolvePreAuthTheme()`: only a non-null hit is ever persisted.
      if (theme.name !== null && theme.css !== null) {
        writePreAuthThemeCache(theme.name, theme.css)
      }
      if (isSsoRequired(result)) {
        ssoProviderName = result.providerName
        step = 'sso'
      } else {
        step = 'password'
      }
    } catch {
      // AC-3/AC-3a: any failure (server error response, thrown ApiClientError, or a network-level
      // failure of the fetch call itself) falls open to the password field — never a hung or
      // broken login screen. Story 16.4: also falls open to the base theme (never a stale
      // previously-resolved theme lingering after a failed lookup for a different email).
      if (email === requestEmail) {
        setPreAuthTheme(null, null)
        step = 'password'
      }
    } finally {
      // Only clear the flag if a newer request (for a different email) hasn't already taken over
      // tracking it — otherwise a stale response's finally could re-enable Continue for an email
      // whose own lookup is still genuinely in flight.
      if (pendingLookupEmail === requestEmail) pendingLookupEmail = null
    }
  }

  async function submitPasswordStep() {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    statusMessage = null
    try {
      const result = await login(fetch, buildLoginRequest({ email, password }))
      password = ''
      if (isMfaChallenge(result)) {
        mfaToken = result.mfaToken
        statusMessage = 'MFA verification is required to finish signing in.'
        return
      }
      await completeSession()
    } catch (error) {
      password = ''
      errorMessage =
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'invalid_credentials'
          ? 'Check your email and password, then try again.'
          : error instanceof Error
            ? error.message
            : 'Sign in failed.'
    } finally {
      isSubmitting = false
    }
  }

  // Story 14.4 Task 3.5: no hosted external-IdP-redirect page exists yet — reuses Story 14.3's
  // start/callback credential-exchange contract exactly, via a generic in-page credential step.
  async function submitSsoStep() {
    if (isSubmitting || !ssoProviderName) return
    isSubmitting = true
    errorMessage = null
    statusMessage = null
    try {
      await ssoStart(fetch, ssoProviderName)
      const result = await ssoCallback(fetch, ssoProviderName, { credential: ssoCredential })
      ssoCredential = ''
      if (isMfaChallenge(result)) {
        mfaToken = result.mfaToken
        statusMessage = 'MFA verification is required to finish signing in.'
        return
      }
      await completeSession()
    } catch (error) {
      ssoCredential = ''
      errorMessage = error instanceof Error ? error.message : 'SSO sign-in failed.'
    } finally {
      isSubmitting = false
    }
  }

  // Story 14.4 Task 3.7: lets a user who fat-fingered their email (or wants local login after
  // being routed to SSO) return to Step A instead of getting stuck.
  function useADifferentEmail() {
    step = 'email'
    ssoProviderName = null
    ssoCredential = ''
    password = ''
    errorMessage = null
    statusMessage = null
  }

  function restartLogin() {
    mfaToken = null
    statusMessage = 'Your login step expired. Please sign in again.'
  }
</script>

{#snippet emailField()}
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="login-email">Email</label>
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="login-email"
      type="email"
      bind:value={email}
      required
    />
  </div>
{/snippet}

{#snippet statusAndErrorMessages()}
  {#if statusMessage}
    <p class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      {statusMessage}
    </p>
  {/if}
  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}
{/snippet}

{#if mfaToken}
  <div class="space-y-4">
    {#if statusMessage}
      <p class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        {statusMessage}
      </p>
    {/if}
    <MfaLoginForm {mfaToken} onExpired={restartLogin} />
    <button
      class="text-sm font-medium text-slate-700 underline"
      type="button"
      onclick={() => (mfaToken = null)}
    >
      Use a different password
    </button>
  </div>
{:else if step === 'email'}
  <form
    class="space-y-5"
    onsubmit={(event) => {
      event.preventDefault()
      void submitEmailStep()
    }}
  >
    {@render emailField()}
    {#if errorMessage}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {errorMessage}
      </p>
    {/if}
    <button
      class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      type="submit"
      disabled={pendingLookupEmail === email}
    >
      {pendingLookupEmail === email ? 'Checking...' : 'Continue'}
    </button>
  </form>
{:else if step === 'sso'}
  <form
    class="space-y-5"
    onsubmit={(event) => {
      event.preventDefault()
      void submitSsoStep()
    }}
  >
    <p class="text-sm text-slate-600">
      {email} signs in with your organization's SSO provider.
    </p>
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="sso-credential">SSO credential</label>
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="sso-credential"
        type="text"
        bind:value={ssoCredential}
        required
      />
    </div>
    {@render statusAndErrorMessages()}
    <button
      class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      type="submit"
      disabled={isSubmitting}
    >
      {isSubmitting ? 'Signing in...' : 'Continue with SSO'}
    </button>
    <button
      class="text-sm font-medium text-slate-700 underline"
      type="button"
      onclick={useADifferentEmail}
    >
      Use a different email
    </button>
  </form>
{:else}
  <form
    class="space-y-5"
    onsubmit={(event) => {
      event.preventDefault()
      void submitPasswordStep()
    }}
  >
    {@render emailField()}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="login-password">Password</label>
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="login-password"
        type="password"
        autocomplete="current-password"
        bind:value={password}
        required
      />
    </div>
    {@render statusAndErrorMessages()}
    <button
      class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      type="submit"
      disabled={isSubmitting}
    >
      {isSubmitting ? 'Signing in...' : 'Sign in'}
    </button>
  </form>
{/if}
