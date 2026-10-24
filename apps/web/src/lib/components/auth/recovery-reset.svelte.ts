import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { ApiClientError } from '$lib/api/client.js'
import {
  completeRecovery,
  peekRecovery,
  startRecoveryMfa,
  type RecoveryCompleteRequest,
} from '$lib/api/recovery.js'

export type RecoveryStatus =
  'loading' | 'ready' | 'not_found' | 'expired' | 'used' | 'superseded' | 'error'

const STATUS_BY_CODE: Record<string, RecoveryStatus> = {
  recovery_token_not_found: 'not_found',
  recovery_token_expired: 'expired',
  recovery_token_used: 'used',
  recovery_token_superseded: 'superseded',
}

function completionMessage(error: unknown): string {
  const fallback = 'Could not complete account recovery.'
  return error instanceof ApiClientError ? (error.message ?? fallback) : fallback
}

/**
 * Story 69.14: the one owner of the account recovery state. The link status, the typed password,
 * the MFA opt-in and the typed code live here and only here: the sub-regions of the recovery page
 * read and bind them, and no injection point is ever given any of it.
 */
export class RecoveryReset {
  status = $state<RecoveryStatus>('loading')
  newPassword = $state('')
  wantsMfa = $state(false)
  mfaQrCodeSvg = $state<string | null>(null)
  mfaSecret = $state<string | null>(null)
  totpCode = $state('')
  isSubmitting = $state(false)
  isStartingMfa = $state(false)
  errorMessage = $state<string | null>(null)
  issuedRecoveryCodes = $state<string[] | null>(null)

  readonly #token: string

  constructor(token: string) {
    this.#token = token
  }

  async loadPeek(): Promise<void> {
    try {
      await peekRecovery(fetch, this.#token)
      this.status = 'ready'
    } catch (error) {
      this.status =
        error instanceof ApiClientError && error.code
          ? (STATUS_BY_CODE[error.code] ?? 'error')
          : 'error'
    }
  }

  async toggleMfa(): Promise<void> {
    this.wantsMfa = !this.wantsMfa
    if (!this.wantsMfa || this.mfaQrCodeSvg) return
    this.isStartingMfa = true
    this.errorMessage = null
    try {
      const result = await startRecoveryMfa(fetch, this.#token)
      this.mfaQrCodeSvg = result.qrCodeSvg
      this.mfaSecret = result.secret
    } catch {
      this.errorMessage =
        'Could not start MFA re-enrollment. You can still reset your password below.'
      this.wantsMfa = false
    } finally {
      this.isStartingMfa = false
    }
  }

  async submit(): Promise<void> {
    if (this.isSubmitting) return
    // Guard against silently dropping MFA re-enrollment: if the user opted in and started
    // staging a secret, an empty/incomplete code must not be swallowed into a plain password
    // reset with no explanation (adversarial review finding).
    if (this.#codeMissing()) {
      this.errorMessage =
        'Enter the 6-digit code from your authenticator app, or uncheck MFA setup.'
      return
    }
    this.isSubmitting = true
    this.errorMessage = null
    try {
      const result = await completeRecovery(fetch, this.#token, this.#request())
      if (result.recoveryCodes && result.recoveryCodes.length > 0) {
        this.issuedRecoveryCodes = result.recoveryCodes
        return
      }
      await this.continueToLogin()
    } catch (error) {
      this.errorMessage = completionMessage(error)
    } finally {
      this.isSubmitting = false
    }
  }

  #codeMissing(): boolean {
    return Boolean(this.wantsMfa && this.mfaQrCodeSvg) && !/^\d{6}$/.test(this.totpCode.trim())
  }

  #request(): RecoveryCompleteRequest {
    return {
      newPassword: this.newPassword,
      ...(this.wantsMfa && this.totpCode ? { totpCode: this.totpCode } : {}),
    }
  }

  async continueToLogin(): Promise<void> {
    await goto(resolve('/login?reason=recovery-complete'))
  }
}
