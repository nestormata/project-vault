import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { ApiClientError } from '$lib/api/client.js'
import { claimHandoff, getCurrentUser } from '$lib/api/auth.js'
import { m } from '$lib/paraglide/messages.js'

export type HandoffClaimPhase = 'working' | 'mfa' | 'failed'

/**
 * Story 73.1: the one owner of the /auth/claim state machine, created by `HandoffClaimContent` and
 * read by its state sub-regions. `start()` takes the token from the URL fragment, drops the
 * fragment from history before anything else can see it, and posts the token to PV web's claim
 * route (which adds the nonce from the host-only cookie). No click and no retry: the nonce is
 * spent on first presentation, so any failure needs a new /auth/start.
 */
export class HandoffClaimFlow {
  phase = $state<HandoffClaimPhase>('working')
  mfaToken = $state<string | null>(null)
  failureMessage = $state<string>(m.auth_handoff_generic_rejection())

  start = (): void => {
    const token = window.location.hash.replace(/^#/, '')
    window.history.replaceState(window.history.state, '', window.location.pathname)
    if (token) void this.claim(token)
    else this.fail(m.auth_handoff_generic_rejection())
  }

  // Always the hardcoded /dashboard (D8: no return path yet), never a value from the URL.
  completeSession = async (): Promise<void> => {
    await getCurrentUser(fetch)
    await goto(resolve('/dashboard'))
  }

  handleMfaExpired = (): void => {
    this.fail(m.auth_mfa_expired())
  }

  private async claim(token: string): Promise<void> {
    try {
      const result = await claimHandoff(fetch, token)
      if ('mfaRequired' in result && result.mfaRequired) {
        this.mfaToken = result.mfaToken
        this.phase = 'mfa'
        return
      }
      await this.completeSession()
    } catch (error) {
      // The backend's message is never shown: a 401 gets the coordinated generic copy, anything
      // else (503, network) the login-failed copy.
      const rejected = error instanceof ApiClientError && error.status === 401
      this.fail(rejected ? m.auth_handoff_generic_rejection() : m.auth_handoff_login_failed())
    }
  }

  private fail(message: string): void {
    this.mfaToken = null
    this.failureMessage = message
    this.phase = 'failed'
  }
}
