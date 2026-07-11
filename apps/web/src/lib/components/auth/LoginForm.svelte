<script lang="ts">
  import { goto } from '$app/navigation'
  import { getCurrentUser, login } from '$lib/api/auth.js'
  import { buildLoginRequest, clearLoginFields, isMfaChallenge } from './form-model.js'
  import MfaLoginForm from './MfaLoginForm.svelte'

  let { nextPath = '/dashboard' }: { nextPath?: string } = $props()

  let email = $state('')
  let password = $state('')
  let mfaToken = $state(null)
  let statusMessage = $state(null)
  let errorMessage = $state(null)
  let isSubmitting = $state(false)

  function clearFields() {
    const cleared = clearLoginFields({ email, password })
    email = cleared.email
    password = cleared.password
  }

  async function submitForm() {
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
      await getCurrentUser(fetch)
      clearFields()
      // nextPath is a caller-supplied, same-origin-only redirect target (see safeNextPath() in
      // the login page) — not a static route resolve() can type-check at compile time.
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(nextPath)
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

  function restartLogin() {
    mfaToken = null
    statusMessage = 'Your login step expired. Please sign in again.'
  }
</script>

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
{:else}
  <form
    class="space-y-5"
    onsubmit={(event) => {
      event.preventDefault()
      void submitForm()
    }}
  >
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
    <button
      class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      type="submit"
      disabled={isSubmitting}
    >
      {isSubmitting ? 'Signing in...' : 'Sign in'}
    </button>
  </form>
{/if}
