import {
  confirmExternalShareVerification,
  sendExternalShareVerification,
} from '$lib/api/credential-shares.js'
import { ApiClientError } from '$lib/api/client.js'

export type VerificationFailure = 'failed' | 'unavailable' | null

type Deps = {
  fetchFn: typeof fetch
  token: string
  initialMask: string
  /** Called once with the proof of a successful confirm. The proof is never stored here. */
  onVerified: (proof: string) => void
}

// Story 72.11: the guest page's code step. Everything lives in component memory: the token comes
// from the page, the code is what the guest types, and the proof is handed straight to `onVerified`
// (the parent keeps it in memory only: never the URL, web storage or a cookie). The send route
// answers the same 200 whatever the share's state, so the only feedback is the cooldown it names.
export class ExternalShareVerificationController {
  maskedRecipient = $state('')
  requested = $state(false)
  sending = $state(false)
  confirming = $state(false)
  cooldownRemaining = $state(0)
  code = $state('')
  failure = $state<VerificationFailure>(null)

  readonly #deps: Deps
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: Deps) {
    this.#deps = deps
    this.maskedRecipient = deps.initialMask
  }

  get canResend(): boolean {
    return !this.sending && this.cooldownRemaining === 0
  }

  get canConfirm(): boolean {
    return !this.confirming && /^\d{6}$/.test(this.code)
  }

  #startCooldown(seconds: number): void {
    this.#stopTimer()
    this.cooldownRemaining = seconds
    if (seconds <= 0) return
    this.#timer = setInterval(() => {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - 1)
      if (this.cooldownRemaining === 0) this.#stopTimer()
    }, 1000)
  }

  #stopTimer(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  dispose(): void {
    this.#stopTimer()
  }

  async send(): Promise<void> {
    if (!this.canResend) return
    this.sending = true
    this.failure = null
    try {
      const result = await sendExternalShareVerification(this.#deps.fetchFn, this.#deps.token)
      this.maskedRecipient = result.maskedRecipient
      this.requested = true
      this.code = ''
      this.#startCooldown(result.cooldownSeconds)
    } catch {
      this.failure = 'unavailable'
    } finally {
      this.sending = false
    }
  }

  async confirm(): Promise<void> {
    if (!this.canConfirm) return
    this.confirming = true
    this.failure = null
    try {
      const result = await confirmExternalShareVerification(
        this.#deps.fetchFn,
        this.#deps.token,
        this.code
      )
      this.code = ''
      this.#stopTimer()
      this.#deps.onVerified(result.proof)
    } catch (error) {
      // One generic 422 for every failed check (V7); anything else is a transport or server fault.
      this.failure =
        error instanceof ApiClientError && error.status === 422 ? 'failed' : 'unavailable'
    } finally {
      this.confirming = false
    }
  }
}
