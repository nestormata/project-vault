<script lang="ts">
  import type { ExternalShareMetadata } from '$lib/api/credential-shares.js'
  import type { Snippet } from 'svelte'
  import { mapShareRevealError } from '$lib/api/credential-share-reveal-error.js'
  import { revealExternalCredentialShare } from '$lib/api/credential-shares.js'
  import {
    createShareRevealState,
    revealShareValue,
  } from '$lib/components/credential-shares/reveal-state.svelte.js'
  import ShareRevealContent from '$lib/components/credential-shares/ShareRevealContent.svelte'
  import ExternalShareVerification from '$lib/components/credential-shares/ExternalShareVerification.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import SharedCredentialSummary from '$lib/components/credential-shares/SharedCredentialSummary.svelte'

  let {
    metadata,
    token,
    error,
    children,
  }: {
    metadata: ExternalShareMetadata | null
    token: string
    error: 'not_found' | 'unavailable' | null
    children?: Snippet
  } = $props()

  // Story 72.11 V8: the proof of a verified gated share lives in this component's memory only (never
  // the URL, web storage or a cookie); it is sent in the reveal body and dropped once used.
  let proof = $state<string | null>(null)
  const needsVerification = $derived(metadata?.verificationRequired === true && proof === null)

  async function onReveal(): Promise<void> {
    if (reveal.revealing || !metadata) return
    const heldProof = proof ?? undefined
    await revealShareValue(
      reveal,
      () => revealExternalCredentialShare(fetch, token, heldProof),
      mapShareRevealError
    )
    // Dropped on success only: a failed reveal keeps it so the page shows the terminal reason.
    if (reveal.revealedValue !== null) proof = null
  }
  // Story 17.2 AC-9: two-step reveal, never on first request — this only fires on Priya's
  // explicit "Reveal secret" button click, mirroring 17.1's own reveal-page pattern. Unlike
  // 17.1's session-bound page, this unauthenticated path never produces the 'ineligible' reason.
  const reveal = createShareRevealState<'expired' | 'already_viewed' | 'revoked' | 'other'>()
</script>

{@render children?.()}
{#if error === 'not_found'}
  <p class="text-sm text-slate-700">This link is invalid, has expired, or has already been used.</p>
{:else if error === 'unavailable'}
  <p class="text-sm text-slate-700">
    This link couldn't be checked right now. Please try again in a moment.
  </p>
{:else if metadata}
  <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <SharedCredentialSummary
      sharedByLabel={metadata.sharedByDisplayName}
      credentialName={metadata.credentialName}
      fieldKey={metadata.fieldKey ?? null}
      attributeKeys={metadata.attributeKeys ?? null}
      expiresAt={metadata.expiresAt}
      expiryNote="single view only"
    />

    {#if metadata.status !== 'active'}
      <p class="mt-4 text-sm text-red-700">This link is no longer active.</p>
    {:else if needsVerification && reveal.revealedValue === null}
      <ExternalShareVerification
        {token}
        maskedRecipient={metadata.maskedRecipient ?? ''}
        onVerified={(verifiedProof) => (proof = verifiedProof)}
      />
    {:else}
      {#if metadata.verificationRequired && reveal.revealedValue === null}
        <p class="mt-4 text-sm text-emerald-800" role="status">{m.guest_verify_verified()}</p>
      {/if}
      <ShareRevealContent
        revealedValue={reveal.revealedValue}
        valueFormat={reveal.revealedValueFormat}
        revealError={reveal.revealError}
        revealing={reveal.revealing}
        {onReveal}
        buttonLabel="Reveal secret"
        expiredMessage="This link has expired."
        alreadyViewedMessage="This link has already been used."
        revokedMessage="This link has been revoked."
        otherMessage="Could not reveal this secret. Try again."
      />
    {/if}
  </div>
{/if}
