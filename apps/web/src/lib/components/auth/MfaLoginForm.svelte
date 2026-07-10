<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { getCurrentUser, verifyMfaLogin } from '$lib/api/auth.js'
  import { buildMfaLoginRequest, clearMfaLoginFields } from './form-model.js'

  let { mfaToken, onExpired } = $props()
  let totp = $state('')
  let errorMessage = $state(null)
  let isSubmitting = $state(false)

  function clearFields(clearToken = false) {
    const cleared = clearMfaLoginFields({ mfaToken: clearToken ? mfaToken : '', totp })
    totp = cleared.totp
    if (clearToken) mfaToken = cleared.mfaToken
  }

  async function submitForm() {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    try {
      await verifyMfaLogin(fetch, buildMfaLoginRequest({ mfaToken, totp }))
      await getCurrentUser(fetch)
      clearFields(true)
      await goto(resolve('/dashboard'))
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
      if (code === 'mfa_token_expired') {
        clearFields(true)
        onExpired?.()
        errorMessage = 'Your login step expired. Please sign in again.'
        return
      }
      clearFields(false)
      errorMessage =
        code === 'invalid_totp'
          ? 'That code was not accepted. Try the next code from your authenticator.'
          : error instanceof Error
            ? error.message
            : 'MFA verification failed.'
    } finally {
      isSubmitting = false
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
    <label class="block font-medium text-slate-900" for="mfa-totp">Authenticator code</label>
    <!-- Story 10-1 discovered this as a real, no-mock browser bug: a literal pattern="[0-9]{6}"
         is misparsed by Svelte's attribute compiler — "{6}" reads as a mustache expression
         evaluating to the number 6, producing pattern="[0-9]6" in the rendered DOM (verified via
         page.evaluate() against the real running app). That pattern requires a digit followed by
         a literal "6", which no real 6-digit TOTP code satisfies — native HTML5 constraint
         validation silently blocked every MFA login submission (click or Enter) for every real
         user, with no console error, since the browser just refuses to fire the 'submit' event.
         Wrapping in a JS expression avoids the mixed-content parse. -->
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="mfa-totp"
      inputmode="numeric"
      pattern={'[0-9]{6}'}
      autocomplete="one-time-code"
      bind:value={totp}
      required
    />
    <p class="text-sm text-slate-600">Enter the six-digit code from your authenticator app.</p>
  </div>
  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}
  <button
    class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
    type="submit"
    disabled={isSubmitting}
  >
    {isSubmitting ? 'Verifying...' : 'Verify MFA code'}
  </button>
</form>
