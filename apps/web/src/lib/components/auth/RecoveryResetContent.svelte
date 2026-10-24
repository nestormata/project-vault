<script lang="ts">
  import type { Snippet } from 'svelte'
  import { onMount } from 'svelte'
  import { page } from '$app/state'
  import RecoveryCodes from './RecoveryCodes.svelte'
  import RecoveryLinkStatus from './RecoveryLinkStatus.svelte'
  import RecoveryResetForm from './RecoveryResetForm.svelte'
  import { RecoveryReset } from './recovery-reset.svelte.js'

  // Story 69.14: the recovery page is the link status, the recovery codes and the reset form, each
  // a region hosting its own point. This component owns the one recovery state (`flow`) they share.
  let {
    data,
    children,
  }: { data?: Record<string, readonly unknown[]> | undefined; children?: Snippet } = $props()

  const flow = new RecoveryReset(page.params.token ?? '')
  onMount(() => {
    void flow.loadPeek()
  })
</script>

<div class="space-y-6">
  {#if flow.status !== 'ready'}
    <RecoveryLinkStatus status={flow.status} {data} />
  {:else if flow.issuedRecoveryCodes}
    <RecoveryCodes
      codes={flow.issuedRecoveryCodes}
      onContinue={() => void flow.continueToLogin()}
      {data}
    />
  {:else}
    <RecoveryResetForm {flow} {data} />
  {/if}
</div>
{@render children?.()}
