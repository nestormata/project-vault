<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { isServiceProvisionedEmail } from '@project-vault/shared'
  import { confirmHandoff, getCurrentUser } from '$lib/api/auth.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { m } from '$lib/paraglide/messages.js'
  import MfaLoginForm from '$lib/components/auth/MfaLoginForm.svelte'

  // Story 30.5 Task 1/AC1: this page follows `login/+page.svelte`'s existing precedent (Dev
  // Notes) of reading `page.url.searchParams` directly in the component rather than adding a
  // `+page.ts`/`+page.server.ts` `load` — the validation here is trivial (shape checks only, no
  // server-only data needed) and every other `(auth)` query-param-driven page already does this
  // inline. Documented here as the deliberate choice Dev Notes asked to record.
  // Story 60.3 later added a `+page.server.ts` `load` for the claim exchange; Story 60.4 has it
  // return `centralizeMeOrigin` (server-side config only). `data` is optional so the page still
  // renders — with plain-text guidance — when no load data is supplied.
  let { data }: { data?: { centralizeMeOrigin?: string | null } } = $props()
  let centralizeMeOrigin = $derived(data?.centralizeMeOrigin ?? null)

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
  function accountDisplayValue(raw: string | null, fallback: string): string {
    return isServiceProvisionedEmail(raw) ? fallback : displayValue(raw, fallback)
  }

  let searchParams = $derived(page.url.searchParams)
  let pendingIdParam = $derived(searchParams.get('pendingId'))
  // AC1.2/AC1.4: no pendingId at all (direct navigation, bookmark, reload) or a malformed one
  // both render the same neutral error state, with no Confirm button — there is nothing safe to
  // confirm without a real pending state to reference.
  let hasValidPendingId = $derived(
    pendingIdParam !== null && pendingIdParam !== '' && PENDING_ID_PATTERN.test(pendingIdParam)
  )
  let organizationName = $derived(
    displayValue(searchParams.get('organizationName'), m.auth_handoff_fallback_organization())
  )
  let accountLabel = $derived(
    accountDisplayValue(searchParams.get('accountLabel'), m.auth_handoff_fallback_account())
  )

  type Phase = 'ready' | 'submitting' | 'mfa' | 'rejected' | 'login_failed' | 'network_error'
  let phase = $state<Phase>('ready')
  let mfaToken = $state<string | null>(null)
  let rejectionMessage = $state<string | null>(null)

  // Story 30.5 Task 3: `LoginForm.svelte`'s `completeSession()` also patches a pending
  // registration-locale preference — logic specific to the registration flow that has no
  // equivalent here. Extracting a shared helper would mean either widening it with a flag/option
  // that only this page uses, or risking `LoginForm.svelte`'s own behavior/tests — neither is
  // justified for the couple of lines this page actually needs, so this duplicates the small,
  // safe subset (`getCurrentUser` + navigate to `/dashboard`) instead, per Dev Notes' explicit
  // "otherwise duplicate" guidance.
  async function completeSession() {
    await getCurrentUser(fetch)
    // AC5.19: always the hardcoded `/dashboard`, mirroring `LoginForm.svelte` — never a
    // `next`/`returnTo` query parameter read from this page's own URL.
    // eslint-disable-next-line svelte/no-navigation-without-resolve
    await goto('/dashboard')
  }

  function handleMfaExpired() {
    mfaToken = null
    phase = 'rejected'
    rejectionMessage = m.auth_mfa_expired()
  }

  async function handleConfirm() {
    // AC2.9: double-click / already-submitting guard.
    if (phase === 'submitting') return
    phase = 'submitting'
    rejectionMessage = null
    try {
      const result = await confirmHandoff(fetch)
      if ('mfaRequired' in result && result.mfaRequired) {
        mfaToken = result.mfaToken
        phase = 'mfa'
        return
      }
      await completeSession()
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        // AC2.7: always the shared generic-rejection copy, byte-identical (in English) to the
        // backend's own constant — never the raw response body's message, so an unparsable body
        // (already falls back inside `apiFetch`/`parseApiEnvelope`) can never surface anything
        // other than this exact, coordinated string.
        phase = 'rejected'
        rejectionMessage = m.auth_handoff_generic_rejection()
      } else if (error instanceof ApiClientError && error.status === 503) {
        // AC2.8: a distinct message from the 401 case — a genuine backend/infra failure, not a
        // rejected credential.
        phase = 'login_failed'
      } else {
        // AC2.10: a thrown/rejected fetch (never reached the server, or a non-HTTP failure) —
        // distinct from both the 401 and 503 branches, and re-enables the Confirm button, since
        // retrying is harmless in the worst case either way.
        phase = 'network_error'
      }
    }
  }
</script>

<!-- Story 60.4 AC2/AC3 (F11): every terminal error state (no-params/malformed, rejected, and
login_failed) shares this block — an error heading instead of "Confirm sign-in", the alert, and
guidance back to CentralizeMe. The guidance is deliberately outside the role="alert" element (the
alert announces the error; this is follow-up help) and is never a retry action on PV. It is an
<a> only when `centralizeMeOrigin` is set — resolved server-side from the web process's own
VAULT_HANDOFF_ISSUER (origin only, http(s) only), never from this page's query string. Same tab;
rel="external" marks it as a full-document navigation off-site (SvelteKit's router skips it), and
rel="noreferrer" keeps this /handoff URL (which may still carry pendingId/claim) from being sent to
CM as a Referer. Both branches render from the same two message keys so the wording cannot
drift. -->
{#snippet terminalError(message: string | null)}
  <div class="space-y-2">
    <h1 class="text-2xl font-bold">{m.auth_handoff_error_heading()}</h1>
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {message}
    </p>
    <p class="text-sm text-slate-600">
      {#if centralizeMeOrigin}<a
          class="font-medium text-brand-600 underline"
          href={centralizeMeOrigin}
          rel="external noopener noreferrer">{m.auth_handoff_return_link_text()}</a
        >{:else}{m.auth_handoff_return_link_text()}{/if}{m.auth_handoff_return_suffix()}
    </p>
  </div>
{/snippet}

<div class="space-y-6">
  {#if !hasValidPendingId}
    <!-- AC1.2/AC1.4: neutral error state, no Confirm button — reuses the backend's exact generic
    rejection message string. -->
    {@render terminalError(m.auth_handoff_generic_rejection())}
  {:else if phase === 'mfa' && mfaToken}
    <div class="space-y-4">
      <h1 class="text-2xl font-bold">{m.auth_handoff_confirm_heading()}</h1>
      <p class="text-sm text-slate-600">{m.auth_handoff_mfa_prompt()}</p>
      <MfaLoginForm {mfaToken} onExpired={handleMfaExpired} onAuthenticated={completeSession} />
    </div>
  {:else if phase === 'rejected'}
    <!-- AC2.7: no "retry" is offered (the pending state is very likely already consumed or was
    never valid) — only guidance back to where the user's CM session started. Story 60.4: that
    guidance links to CentralizeMe only when an operator configured VAULT_HANDOFF_ISSUER on the web
    process (see the terminalError snippet); otherwise it stays plain text. -->
    {@render terminalError(rejectionMessage)}
  {:else if phase === 'login_failed'}
    {@render terminalError(m.auth_handoff_login_failed())}
  {:else}
    <div class="space-y-4">
      <h1 class="text-2xl font-bold">{m.auth_handoff_confirm_heading()}</h1>
      <!-- AC1.6: long attacker-influenced values wrap rather than breaking layout; never sliced. -->
      <p class="break-words text-slate-700">
        {m.auth_handoff_confirm_prompt({ accountLabel, organizationName })}
      </p>
      {#if phase === 'network_error'}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {m.auth_handoff_network_error()}
        </p>
      {/if}
      <!-- Story 60.4 AC4: "Not me" is a link (it navigates) to /login, secondary-styled, beside
      Confirm in a wrapping row. It makes no API call — the pending state and its httpOnly cookie
      simply expire on their existing 120s TTL. Inert while a confirm is in flight so the user
      cannot land on /login while a session cookie is being set. -->
      <div class="flex flex-wrap gap-3">
        <button
          class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          disabled={phase === 'submitting'}
          onclick={() => void handleConfirm()}
        >
          {phase === 'submitting' ? m.auth_handoff_confirming() : m.auth_handoff_confirm_button()}
        </button>
        <a
          class="rounded-xl border border-slate-300 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50"
          class:pointer-events-none={phase === 'submitting'}
          class:opacity-60={phase === 'submitting'}
          href={resolve('/login')}
          aria-disabled={phase === 'submitting' ? 'true' : undefined}
          tabindex={phase === 'submitting' ? -1 : undefined}
        >
          {m.auth_handoff_cancel()}
        </a>
      </div>
    </div>
  {/if}
</div>

<svelte:head>
  <title>{m.auth_handoff_page_title()}</title>
</svelte:head>
