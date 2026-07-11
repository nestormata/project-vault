<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import { ApiClientError } from '$lib/api/client.js'
  import { completeRecovery, peekRecovery, startRecoveryMfa } from '$lib/api/recovery.js'

  const token = page.params.token ?? ''

  type Status = 'loading' | 'ready' | 'not_found' | 'expired' | 'used' | 'superseded' | 'error'

  let status = $state<Status>('loading')
  let newPassword = $state('')
  let wantsMfa = $state(false)
  let mfaQrCodeSvg = $state<string | null>(null)
  let mfaSecret = $state<string | null>(null)
  let totpCode = $state('')
  let isSubmitting = $state(false)
  let isStartingMfa = $state(false)
  let errorMessage = $state<string | null>(null)
  let issuedRecoveryCodes = $state<string[] | null>(null)

  const STATUS_BY_CODE: Record<string, Status> = {
    recovery_token_not_found: 'not_found',
    recovery_token_expired: 'expired',
    recovery_token_used: 'used',
    recovery_token_superseded: 'superseded',
  }

  async function loadPeek() {
    try {
      await peekRecovery(fetch, token)
      status = 'ready'
    } catch (error) {
      status =
        error instanceof ApiClientError && error.code
          ? (STATUS_BY_CODE[error.code] ?? 'error')
          : 'error'
    }
  }

  async function onToggleMfa() {
    wantsMfa = !wantsMfa
    if (!wantsMfa || mfaQrCodeSvg) return
    isStartingMfa = true
    errorMessage = null
    try {
      const result = await startRecoveryMfa(fetch, token)
      mfaQrCodeSvg = result.qrCodeSvg
      mfaSecret = result.secret
    } catch {
      errorMessage = 'Could not start MFA re-enrollment. You can still reset your password below.'
      wantsMfa = false
    } finally {
      isStartingMfa = false
    }
  }

  async function submitForm() {
    if (isSubmitting) return
    // Guard against silently dropping MFA re-enrollment: if the user opted in and started
    // staging a secret, an empty/incomplete code must not be swallowed into a plain password
    // reset with no explanation (adversarial review finding).
    if (wantsMfa && mfaQrCodeSvg && !/^\d{6}$/.test(totpCode.trim())) {
      errorMessage = 'Enter the 6-digit code from your authenticator app, or uncheck MFA setup.'
      return
    }
    isSubmitting = true
    errorMessage = null
    try {
      const result = await completeRecovery(fetch, token, {
        newPassword,
        ...(wantsMfa && totpCode ? { totpCode } : {}),
      })
      if (result.recoveryCodes && result.recoveryCodes.length > 0) {
        issuedRecoveryCodes = result.recoveryCodes
        return
      }
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic query string
      await goto('/login?reason=recovery-complete')
    } catch (error) {
      errorMessage =
        error instanceof ApiClientError
          ? (error.message ?? 'Could not complete account recovery.')
          : 'Could not complete account recovery.'
    } finally {
      isSubmitting = false
    }
  }

  async function continueToLogin() {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic query string
    await goto('/login?reason=recovery-complete')
  }

  onMount(() => {
    void loadPeek()
  })
</script>

<svelte:head>
  <title>Reset your password | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  {#if status === 'loading'}
    <p class="text-slate-600">Checking your recovery link...</p>
  {:else if status === 'not_found'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Recovery link not found</h1>
      <p class="text-slate-600">This recovery link doesn't exist. Request a new one.</p>
    </div>
  {:else if status === 'expired'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Recovery link expired</h1>
      <p class="text-slate-600">
        This link expired after 15 minutes. Request a new one to continue.
      </p>
    </div>
  {:else if status === 'used'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Recovery link already used</h1>
      <p class="text-slate-600">This link has already been used to reset your password.</p>
    </div>
  {:else if status === 'superseded'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">A newer recovery link was requested</h1>
      <p class="text-slate-600">
        A more recent recovery link superseded this one. Check your email for the latest link.
      </p>
    </div>
  {:else if status === 'error'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Something went wrong</h1>
      <p class="text-slate-600">We couldn't load this recovery link. Please try again.</p>
    </div>
  {:else if issuedRecoveryCodes}
    <div class="space-y-4">
      <h1 class="text-2xl font-bold">Save your recovery codes</h1>
      <p class="text-slate-600">
        Store these somewhere safe. Each code can be used once if you lose access to your
        authenticator app. They won't be shown again.
      </p>
      <ul
        class="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm"
      >
        {#each issuedRecoveryCodes as code (code)}
          <li>{code}</li>
        {/each}
      </ul>
      <button
        class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
        type="button"
        onclick={() => void continueToLogin()}
      >
        Continue to login
      </button>
    </div>
  {:else}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Set a new password</h1>
      <p class="text-slate-600">Choose a new password for your account.</p>
    </div>

    {#if errorMessage}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {errorMessage}
      </p>
    {/if}

    <form
      class="space-y-5"
      onsubmit={(event) => {
        event.preventDefault()
        void submitForm()
      }}
    >
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="recovery-new-password"
          >New password</label
        >
        <input
          class="w-full rounded-xl border border-slate-300 px-3 py-2"
          id="recovery-new-password"
          type="password"
          autocomplete="new-password"
          bind:value={newPassword}
          minlength="12"
          required
        />
        <p class="text-sm text-slate-600">Use at least 12 characters.</p>
      </div>

      <div class="space-y-2">
        <label class="flex items-center gap-2 font-medium text-slate-900">
          <input
            type="checkbox"
            checked={wantsMfa}
            disabled={isStartingMfa}
            onchange={() => void onToggleMfa()}
          />
          Set up two-factor authentication
        </label>
        {#if isStartingMfa}
          <p class="text-sm text-slate-600">Generating a new authenticator secret...</p>
        {/if}
        {#if wantsMfa && mfaQrCodeSvg}
          <div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p class="text-sm text-slate-600">Scan this code with your authenticator app:</p>
            <img
              class="w-40"
              alt="Authenticator QR code"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(mfaQrCodeSvg)}`}
            />
            {#if mfaSecret}
              <p class="text-xs text-slate-500">Manual entry key: {mfaSecret}</p>
            {/if}
            <label class="block font-medium text-slate-900" for="recovery-totp"
              >Authenticator code</label
            >
            <!-- Story 10-1: pattern="[0-9]{6}" is misparsed by Svelte's attribute compiler
                 ("{6}" reads as a mustache expression, producing pattern="[0-9]6" in the rendered
                 DOM) — see MfaLoginForm.svelte's identical fix for the full explanation. -->
            <input
              class="w-full rounded-xl border border-slate-300 px-3 py-2"
              id="recovery-totp"
              inputmode="numeric"
              pattern={'[0-9]{6}'}
              autocomplete="one-time-code"
              bind:value={totpCode}
            />
          </div>
        {/if}
      </div>

      <button
        class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={isSubmitting}
      >
        {isSubmitting ? 'Resetting...' : 'Reset password'}
      </button>
    </form>
  {/if}
</div>
