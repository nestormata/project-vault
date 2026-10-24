<script lang="ts">
  import type { Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'
  import HandoffConfirm from './HandoffConfirm.svelte'
  import HandoffMfa from './HandoffMfa.svelte'
  import HandoffTerminalError from './HandoffTerminalError.svelte'
  import { HandoffFlow } from './handoff-flow.svelte.js'

  // Story 69.11: the sign-in handoff page body is one sub-region per state of the confirmation: the
  // terminal error (no or malformed pending sign-in, rejected, login failed), the MFA prompt, and
  // the confirm prompt. `HandoffFlow` is the one owner of the state machine; `data` is the page's
  // `__inject` map.
  let {
    centralizeMeOrigin,
    data,
    children,
  }: {
    centralizeMeOrigin: string | null
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const flow = new HandoffFlow()
</script>

<div class="space-y-6">
  {#if !flow.hasValidPendingId}
    <!-- AC1.2/AC1.4: neutral error state, no Confirm button — reuses the backend's exact generic
    rejection message string. -->
    <HandoffTerminalError
      message={m.auth_handoff_generic_rejection()}
      {centralizeMeOrigin}
      {data}
    />
  {:else if flow.phase === 'mfa' && flow.mfaToken}
    <HandoffMfa
      mfaToken={flow.mfaToken}
      onExpired={flow.handleMfaExpired}
      onAuthenticated={flow.completeSession}
      {data}
    />
  {:else if flow.phase === 'rejected'}
    <!-- AC2.7: no "retry" is offered (the pending state is very likely already consumed or was
    never valid) — only guidance back to where the user's CM session started. Story 60.4: that
    guidance links to CentralizeMe only when an operator configured VAULT_HANDOFF_ISSUER on the web
    process (see HandoffTerminalError); otherwise it stays plain text. -->
    <HandoffTerminalError message={flow.rejectionMessage} {centralizeMeOrigin} {data} />
  {:else if flow.phase === 'login_failed'}
    <HandoffTerminalError message={m.auth_handoff_login_failed()} {centralizeMeOrigin} {data} />
  {:else}
    <HandoffConfirm {flow} {data} />
  {/if}
</div>
{@render children?.()}
