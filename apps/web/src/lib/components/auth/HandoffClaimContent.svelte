<script lang="ts">
  import type { Snippet } from 'svelte'
  import { onMount } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'
  import HandoffMfa from './HandoffMfa.svelte'
  import HandoffTerminalError from './HandoffTerminalError.svelte'
  import { HandoffClaimFlow } from './handoff-claim-flow.svelte.js'

  // Story 73.1: the /auth/claim page body, one sub-region per state of the claim: working (an
  // sr-only status and a noscript message), the MFA prompt, and the terminal error. `HandoffClaimFlow`
  // owns the state machine; `data` is the page's `__inject` map.
  let {
    centralizeMeOrigin,
    data,
    children,
  }: {
    centralizeMeOrigin: string | null
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const flow = new HandoffClaimFlow()

  onMount(flow.start)
</script>

<div class="space-y-6">
  {#if flow.phase === 'failed'}
    <HandoffTerminalError message={flow.failureMessage} {centralizeMeOrigin} {data} />
  {:else if flow.phase === 'mfa' && flow.mfaToken}
    <HandoffMfa
      mfaToken={flow.mfaToken}
      onExpired={flow.handleMfaExpired}
      onAuthenticated={flow.completeSession}
      {data}
    />
  {:else}
    <p class="sr-only" role="status">{m.auth_handoff_signing_in()}</p>
    <noscript><p class="text-sm text-slate-600">{m.auth_handoff_noscript()}</p></noscript>
  {/if}
</div>
{@render children?.()}
