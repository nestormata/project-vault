<script lang="ts">
  import { goto } from '$app/navigation'
  import { getCurrentUser, verifyMfaLogin } from '$lib/api/auth.js'
  import { buildMfaLoginRequest, clearMfaLoginFields } from './form-model.js'

  let { mfaToken, onExpired } = $props()
  let totp = $state('')
  let errorMessage = $state(null)

  function clearFields(clearToken = false) {
    const cleared = clearMfaLoginFields({ mfaToken: clearToken ? mfaToken : '', totp })
    totp = cleared.totp
    if (clearToken) mfaToken = cleared.mfaToken
  }

  async function submitForm() {
    errorMessage = null
    try {
      await verifyMfaLogin(fetch, buildMfaLoginRequest({ mfaToken, totp }))
      await getCurrentUser(fetch)
      clearFields(true)
      await goto('/dashboard')
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
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="mfa-totp"
      inputmode="numeric"
      pattern="[0-9]{6}"
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
  <button class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white" type="submit"
    >Verify MFA code</button
  >
</form>
