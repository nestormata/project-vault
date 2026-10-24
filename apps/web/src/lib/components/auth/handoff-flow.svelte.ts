import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { page } from '$app/state'
import { ApiClientError } from '$lib/api/client.js'
import { confirmHandoff, getCurrentUser } from '$lib/api/auth.js'
import { m } from '$lib/paraglide/messages.js'
import { isServiceProvisionedEmail } from '@project-vault/shared'

// AC1.2: matches the opaque-identifier shape `handoff-routes.ts`'s `generateOpaqueId()`
// produces (`randomBytes(24).toString('base64url')`) — a non-empty base64url string. This is a
// shape check only, never a lookup; the real validity check is the confirm call itself.
const PENDING_ID_PATTERN = /^[A-Za-z0-9_-]+$/

// AC1.5: `resolveDisplayNames()` on the backend can legitimately return `null` for either
// field; if CM's interstitial naively serializes that into the query string it becomes the
// literal text "null" — both cases (missing/empty and the literal string) fall back to the
// same generic phrase, never the literal word "null" shown to the user.
function displayValue(raw: string | null, fallback: string): string {
  if (!raw || raw === 'null') return fallback
  return raw
}

// Story 60.4 AC1 (F10), rollout-gap defense in depth: apps/api's prepare already nulls a
// synthetic `service-provisioned+<id>@invalid.projectvault` label, but CM may forward one
// obtained from a PV instance that predates that fix — it must never be rendered either way.
// Trimmed first so surrounding whitespace can't smuggle the synthetic address past the check.
function accountDisplayValue(raw: string | null, fallback: string): string {
  return isServiceProvisionedEmail(raw?.trim()) ? fallback : displayValue(raw, fallback)
}

export type HandoffPhase =
  'ready' | 'submitting' | 'mfa' | 'rejected' | 'login_failed' | 'network_error'

/**
 * Story 69.11: the one owner of the sign-in handoff confirmation's state machine (phase, MFA token,
 * rejection message and the values read from the page URL), created by `HandoffConfirmContent` and
 * handed to the state sub-regions.
 */
export class HandoffFlow {
  phase = $state<HandoffPhase>('ready')
  mfaToken = $state<string | null>(null)
  rejectionMessage = $state<string | null>(null)

  searchParams = $derived(page.url.searchParams)
  pendingIdParam = $derived(this.searchParams.get('pendingId'))
  // AC1.2/AC1.4: no pendingId at all (direct navigation, bookmark, reload) or a malformed one
  // both render the same neutral error state, with no Confirm button — there is nothing safe to
  // confirm without a real pending state to reference.
  hasValidPendingId = $derived(
    this.pendingIdParam !== null &&
      this.pendingIdParam !== '' &&
      PENDING_ID_PATTERN.test(this.pendingIdParam)
  )
  organizationName = $derived(
    displayValue(this.searchParams.get('organizationName'), m.auth_handoff_fallback_organization())
  )
  accountLabel = $derived(
    accountDisplayValue(this.searchParams.get('accountLabel'), m.auth_handoff_fallback_account())
  )

  // Code review (60-4): aria-disabled/pointer-events only style the link — assistive tech can
  // still activate it, so the click itself is cancelled while a confirm is in flight.
  preventCancelWhileSubmitting = (event: MouseEvent): void => {
    if (this.phase === 'submitting') event.preventDefault()
  }

  // Story 30.5 Task 3: `LoginForm.svelte`'s `completeSession()` also patches a pending
  // registration-locale preference — logic specific to the registration flow that has no
  // equivalent here. Extracting a shared helper would mean either widening it with a flag/option
  // that only this page uses, or risking `LoginForm.svelte`'s own behavior/tests — neither is
  // justified for the couple of lines this page actually needs, so this duplicates the small,
  // safe subset (`getCurrentUser` + navigate to `/dashboard`) instead, as an explicit
  // "otherwise duplicate" decision.
  completeSession = async (): Promise<void> => {
    await getCurrentUser(fetch)
    // AC5.19: always the hardcoded `/dashboard`, mirroring `LoginForm.svelte` — never a
    // `next`/`returnTo` query parameter read from this page's own URL.
    await goto(resolve('/dashboard'))
  }

  handleMfaExpired = (): void => {
    this.mfaToken = null
    this.phase = 'rejected'
    this.rejectionMessage = m.auth_mfa_expired()
  }

  handleConfirm = async (): Promise<void> => {
    // AC2.9: double-click / already-submitting guard.
    if (this.phase === 'submitting') return
    this.phase = 'submitting'
    this.rejectionMessage = null
    try {
      const result = await confirmHandoff(fetch)
      if ('mfaRequired' in result && result.mfaRequired) {
        this.mfaToken = result.mfaToken
        this.phase = 'mfa'
        return
      }
      await this.completeSession()
    } catch (error) {
      this.failed(error)
    }
  }

  private failed(error: unknown): void {
    if (error instanceof ApiClientError && error.status === 401) {
      // AC2.7: always the shared generic-rejection copy, byte-identical (in English) to the
      // backend's own constant — never the raw response body's message, so an unparsable body
      // (already falls back inside `apiFetch`/`parseApiEnvelope`) can never surface anything
      // other than this exact, coordinated string.
      this.phase = 'rejected'
      this.rejectionMessage = m.auth_handoff_generic_rejection()
    } else if (error instanceof ApiClientError && error.status === 503) {
      // AC2.8: a distinct message from the 401 case — a genuine backend/infra failure, not a
      // rejected credential.
      this.phase = 'login_failed'
    } else {
      // AC2.10: a thrown/rejected fetch (never reached the server, or a non-HTTP failure) —
      // distinct from both the 401 and 503 branches, and re-enables the Confirm button, since
      // retrying is harmless in the worst case either way.
      this.phase = 'network_error'
    }
  }
}
