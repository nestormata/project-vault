<script lang="ts">
  import {
    enrollMfa,
    regenerateMfaRecoveryCodes,
    verifyMfaEnrollment,
    type AuthUser,
    type MfaEnrollResponse,
  } from '$lib/api/auth.js'
  import { ApiClientError } from '$lib/api/client.js'
  import {
    describeRemainingRecoveryCodes,
    formatEnrolledAt,
    isValidTotpInput,
    qrCodeDataUri,
  } from './security-model.js'

  let { initialUser }: { initialUser: AuthUser } = $props()

  let user = $state(initialUser)
  let enrollment = $state<MfaEnrollResponse | null>(null)
  let recoveryCodes = $state<string[] | null>(null)
  let totp = $state('')
  let regenerating = $state(false)
  let errorMessage = $state<string | null>(null)
  let isSubmitting = $state(false)

  function mapError(error: unknown, fallback: string): string {
    if (error instanceof ApiClientError) {
      if (error.code === 'invalid_totp') {
        return 'That code was not accepted. Try the next code from your authenticator.'
      }
      return error.message
    }
    return error instanceof Error ? error.message : fallback
  }

  async function startEnrollment() {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    try {
      enrollment = await enrollMfa(fetch)
    } catch (error) {
      errorMessage = mapError(error, 'Could not start MFA enrollment.')
    } finally {
      isSubmitting = false
    }
  }

  function cancelEnrollment() {
    enrollment = null
    totp = ''
    errorMessage = null
  }

  async function submitVerification() {
    if (isSubmitting || !isValidTotpInput(totp)) return
    isSubmitting = true
    errorMessage = null
    try {
      const result = await verifyMfaEnrollment(fetch, { totp })
      user = { ...user, mfaEnrolled: true, mfaEnrolledAt: result.mfaEnrolledAt }
      recoveryCodes = result.recoveryCodes
      enrollment = null
      totp = ''
    } catch (error) {
      errorMessage = mapError(error, 'Could not verify the authenticator code.')
    } finally {
      isSubmitting = false
    }
  }

  function startRegeneration() {
    regenerating = true
    totp = ''
    errorMessage = null
  }

  function cancelRegeneration() {
    regenerating = false
    totp = ''
    errorMessage = null
  }

  async function submitRegeneration() {
    if (isSubmitting || !isValidTotpInput(totp)) return
    isSubmitting = true
    errorMessage = null
    try {
      const result = await regenerateMfaRecoveryCodes(fetch, { totp })
      recoveryCodes = result.recoveryCodes
      user = { ...user, remainingRecoveryCodesCount: result.recoveryCodes.length }
      regenerating = false
      totp = ''
    } catch (error) {
      errorMessage = mapError(error, 'Could not regenerate recovery codes.')
    } finally {
      isSubmitting = false
    }
  }

  function dismissRecoveryCodes() {
    recoveryCodes = null
  }
</script>

{#if recoveryCodes}
  <div class="space-y-4 rounded-2xl border border-emerald-300 bg-emerald-50 p-6">
    <h2 class="text-lg font-semibold text-emerald-950">Save your recovery codes</h2>
    <p class="text-sm text-emerald-900">
      Each code can be used once to sign in if you lose access to your authenticator app. Store them
      somewhere safe — they will not be shown again.
    </p>
    <ul class="space-y-1 rounded-xl border border-emerald-300 bg-white p-4 font-mono text-sm">
      {#each recoveryCodes as code (code)}
        <li>{code}</li>
      {/each}
    </ul>
    <button
      type="button"
      class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white"
      onclick={dismissRecoveryCodes}
    >
      I've saved these codes
    </button>
  </div>
{:else if user.mfaEnrolled}
  <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
    <h2 class="text-lg font-semibold text-slate-950">MFA is enabled</h2>
    <p class="text-sm text-slate-600">Enrolled {formatEnrolledAt(user.mfaEnrolledAt)}.</p>
    <p class="text-sm text-slate-600">
      {describeRemainingRecoveryCodes(user.remainingRecoveryCodesCount)}
    </p>

    {#if !regenerating}
      <button
        type="button"
        class="rounded-xl border border-slate-300 px-4 py-2 font-semibold text-slate-900"
        onclick={startRegeneration}
      >
        Regenerate recovery codes
      </button>
    {:else}
      <form
        class="space-y-3"
        novalidate
        onsubmit={(event) => {
          event.preventDefault()
          void submitRegeneration()
        }}
      >
        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="mfa-security-totp"
            >Authenticator code</label
          >
          <input
            id="mfa-security-totp"
            class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
            inputmode="numeric"
            pattern="[0-9]{6}"
            autocomplete="one-time-code"
            bind:value={totp}
            required
          />
          <p class="text-sm text-slate-600">
            Confirm with your current code — this invalidates any unused recovery codes.
          </p>
        </div>
        <div class="flex gap-3">
          <button
            type="submit"
            class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Regenerating…' : 'Confirm regeneration'}
          </button>
          <button
            type="button"
            class="rounded-xl border border-slate-300 px-4 py-2 font-medium text-slate-900"
            onclick={cancelRegeneration}
          >
            Cancel
          </button>
        </div>
      </form>
    {/if}

    {#if errorMessage}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {errorMessage}
      </p>
    {/if}
  </div>
{:else if enrollment}
  <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
    <h2 class="text-lg font-semibold text-slate-950">Scan this QR code</h2>
    <p class="text-sm text-slate-600">
      Scan with your authenticator app, or enter this code manually:
    </p>
    <img
      class="max-w-[256px]"
      src={qrCodeDataUri(enrollment.qrCodeSvg)}
      alt="Authenticator app QR code"
    />
    <p class="rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-sm">
      {enrollment.secret}
    </p>
    <form
      class="space-y-3"
      novalidate
      onsubmit={(event) => {
        event.preventDefault()
        void submitVerification()
      }}
    >
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="mfa-security-totp"
          >Authenticator code</label
        >
        <input
          id="mfa-security-totp"
          class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
          inputmode="numeric"
          pattern="[0-9]{6}"
          autocomplete="one-time-code"
          bind:value={totp}
          required
        />
        <p class="text-sm text-slate-600">Enter the six-digit code to confirm enrollment.</p>
      </div>
      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}
      <div class="flex gap-3">
        <button
          type="submit"
          class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Verifying…' : 'Verify and enable'}
        </button>
        <button
          type="button"
          class="rounded-xl border border-slate-300 px-4 py-2 font-medium text-slate-900"
          onclick={cancelEnrollment}
        >
          Cancel
        </button>
      </div>
    </form>
  </div>
{:else}
  <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
    <h2 class="text-lg font-semibold text-slate-950">Set up multi-factor authentication</h2>
    <p class="text-sm text-slate-600">
      Add an authenticator app (like Google Authenticator or 1Password) as a second factor for
      signing in.
    </p>
    {#if errorMessage}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {errorMessage}
      </p>
    {/if}
    <button
      type="button"
      class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      disabled={isSubmitting}
      onclick={() => void startEnrollment()}
    >
      Set up authenticator app
    </button>
  </div>
{/if}
