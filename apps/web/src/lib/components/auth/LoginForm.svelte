<script lang="ts">
  import { goto } from '$app/navigation'
  import { getCurrentUser, login, lookupSsoDomain, ssoCallback, ssoStart } from '$lib/api/auth.js'
  import { patchUserLocale } from '$lib/api/locale.js'
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime.js'
  import { setPreAuthTheme, writePreAuthThemeCache } from '$lib/state/theme.svelte.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import PreAuthLanguageSwitcher from './PreAuthLanguageSwitcher.svelte'
  import { consumeRegistrationLocalePending } from './registration-locale.js'
  import {
    buildDomainLookupRequest,
    buildLoginRequest,
    clearLoginFields,
    isMfaChallenge,
    isSsoRequired,
    normalizePreAuthTheme,
  } from './form-model.js'
  import MfaLoginForm from './MfaLoginForm.svelte'

  let {
    nextPath = '/dashboard',
    onLocaleChange,
    // Story 23.2 AC-13: server-resolved from GET /api/v1/health in the page's own load (see
    // +page.server.ts) so the very first paint already reflects it. Defaults to `true` — the
    // fail-safe, byte-identical-to-today direction — so every existing caller/test that doesn't
    // pass this prop is unaffected (AC-16).
    nativeLoginEnabled = true,
  }: { nextPath?: string; onLocaleChange?: () => void; nativeLoginEnabled?: boolean } = $props()

  // Story 14.4 Task 3.1: two-step, email-first flow. 'email' is Step A (email + Continue);
  // 'password' and 'sso' are two of the possible Step B outcomes of the domain-lookup call.
  // Story 23.2 AC-13: 'placeholder' is the third Step B outcome — reached instead of 'password'
  // whenever native login is disabled and the looked-up email has no SSO mapping, i.e. no usable
  // sign-in path exists for it at all. Never both `password` and `placeholder` shown, and never
  // chosen without the lookup actually running (AC-4/AC-13).
  let step = $state<'email' | 'password' | 'sso' | 'placeholder'>('email')

  let email = $state('')
  let password = $state('')
  let ssoProviderName = $state<string | null>(null)
  let ssoCredential = $state('')
  let mfaToken = $state(null)
  let statusMessage = $state(null)
  let errorMessage = $state(null)
  let isSubmitting = $state(false)
  let localeRevision = $state(0)
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
    const user = await getCurrentUser(fetch)
    const pendingLocale = consumeRegistrationLocalePending(user.userId)
    if (pendingLocale) {
      try {
        await patchUserLocale(fetch, pendingLocale)
      } catch (error) {
        // Registration succeeded and the authenticated session is usable even if this optional
        // preference handoff is unavailable. The user can retry from Settings later.
        console.error('[auth.registration_locale_persistence_failed]', error)
      }
    }
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
      } else if (nativeLoginEnabled) {
        step = 'password'
      } else {
        // Story 23.2 AC-13: no SSO mapping for this email's domain, and native login is
        // disabled instance-wide — there is no usable sign-in path for this email at all.
        // Honest placeholder, never a password box that would 403 on submit.
        step = 'placeholder'
      }
    } catch {
      // AC-3/AC-3a: any failure (server error response, thrown ApiClientError, or a network-level
      // failure of the fetch call itself) falls open to the password field — never a hung or
      // broken login screen. Story 16.4: also falls open to the base theme (never a stale
      // previously-resolved theme lingering after a failed lookup for a different email).
      // Story 23.2 AC-13: except when native login is disabled — falling open to a password
      // field there would render a dead form that 403s on submit, so it falls open to the
      // honest placeholder instead.
      if (email === requestEmail) {
        setPreAuthTheme(null, null)
        step = nativeLoginEnabled ? 'password' : 'placeholder'
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
        statusMessage = m.auth_login_mfa_required()
        return
      }
      await completeSession()
    } catch (error) {
      password = ''
      const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
      if (code === 'native_login_disabled') {
        // Story 23.2 AC-13: a rare race — the page's own load already read `nativeLoginEnabled`
        // before an operator's restart flipped the policy mid-session (see AC-4's rolling-restart
        // note). Self-corrects to the honest placeholder without echoing the password (already
        // cleared above) and without a generic "sign in failed" message that would invite a retry.
        step = 'placeholder'
        return
      }
      errorMessage =
        code === 'invalid_credentials'
          ? m.auth_login_invalid_credentials()
          : error instanceof Error
            ? error.message
            : m.auth_login_failed()
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
        statusMessage = m.auth_login_mfa_required()
        return
      }
      await completeSession()
    } catch (error) {
      ssoCredential = ''
      errorMessage = error instanceof Error ? error.message : m.auth_login_failed()
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
    statusMessage = m.auth_login_expired()
  }

  function handleLocaleChange() {
    localeRevision += 1
    onLocaleChange?.()
  }
</script>

{#key localeRevision}
  <div class="mb-5">
    <PreAuthLanguageSwitcher onLocaleChange={handleLocaleChange} />
  </div>

  {#snippet emailField()}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="login-email"
        >{m.auth_login_email()}</label
      >
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="login-email"
        type="email"
        bind:value={email}
        required
        aria-describedby="login-email-help"
      />
      <FormHelpText id="login-email-help" kind="text" />
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
      <MfaLoginForm {mfaToken} onExpired={restartLogin} onAuthenticated={completeSession} />
      <button
        class="text-sm font-medium text-slate-700 underline"
        type="button"
        onclick={() => (mfaToken = null)}
      >
        {m.auth_login_use_different_password()}
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
        {pendingLookupEmail === email ? m.auth_login_checking() : m.auth_login_continue()}
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
        {m.auth_login_sso_description({ email })}
      </p>
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="sso-credential"
          >{m.auth_login_sso_credential()}</label
        >
        <input
          class="w-full rounded-xl border border-slate-300 px-3 py-2"
          id="sso-credential"
          type="text"
          bind:value={ssoCredential}
          required
          aria-describedby="login-sso-help"
        />
        <FormHelpText id="login-sso-help" kind="text" />
      </div>
      {@render statusAndErrorMessages()}
      <button
        class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={isSubmitting}
      >
        {isSubmitting ? m.auth_login_signing_sso() : m.auth_login_continue_sso()}
      </button>
      <button
        class="text-sm font-medium text-slate-700 underline"
        type="button"
        onclick={useADifferentEmail}
      >
        {m.auth_login_use_different_email()}
      </button>
    </form>
  {:else if step === 'placeholder'}
    <!-- Story 23.2 AC-13: the honest placeholder — never a dead password box that 403s on
    submit, and never a fabricated success. -->
    <div class="space-y-4">
      <div class="space-y-2">
        <h2 class="text-lg font-semibold text-slate-900">
          {m.auth_login_external_signin_heading()}
        </h2>
        <p class="text-sm text-slate-600">{m.auth_login_external_signin_description()}</p>
      </div>
      <button
        class="text-sm font-medium text-slate-700 underline"
        type="button"
        onclick={useADifferentEmail}
      >
        {m.auth_login_use_different_email()}
      </button>
    </div>
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
        <label class="block font-medium text-slate-900" for="login-password"
          >{m.auth_login_password()}</label
        >
        <input
          class="w-full rounded-xl border border-slate-300 px-3 py-2"
          id="login-password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          required
          aria-describedby="login-password-help"
        />
        <FormHelpText id="login-password-help" kind="secret" />
      </div>
      {@render statusAndErrorMessages()}
      <button
        class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={isSubmitting}
      >
        {isSubmitting ? m.auth_login_signing_in() : m.auth_login_sign_in()}
      </button>
    </form>
  {/if}
{/key}
