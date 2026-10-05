<script lang="ts">
  import type { ShareMetadata } from '$lib/api/credential-shares.js'
  import type { Snippet } from 'svelte'
  import { mapShareRevealError } from '$lib/api/credential-share-reveal-error.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { revealCredentialShare } from '$lib/api/credential-shares.js'
  import {
    createShareRevealState,
    revealShareValue,
  } from '$lib/components/credential-shares/reveal-state.svelte.js'
  import ShareRevealContent from '$lib/components/credential-shares/ShareRevealContent.svelte'
  import SharedCredentialSummary from '$lib/components/credential-shares/SharedCredentialSummary.svelte'

  let {
    metadata,
    token,
    error,
    children,
  }: {
    metadata: ShareMetadata | null
    token: string
    error: 'not_found' | 'session_mismatch' | null
    children?: Snippet
  } = $props()

  async function onReveal(): Promise<void> {
    if (reveal.revealing || !metadata) return
    await revealShareValue(
      reveal,
      () => revealCredentialShare(fetch, token),
      (error) =>
        error instanceof ApiClientError && error.status === 403
          ? 'ineligible'
          : mapShareRevealError(error)
    )
  }
  // Story 17.1 AC-8: reveal is two-step, never on first request — this only fires on explicit
  // user action (button click), and reuses the existing masked-value/reveal-button visual
  // pattern's spirit (no bespoke second reveal component). 'ineligible' (403) is the one reveal
  // reason unique to this session-bound page — 17.2's external page never sees it.
  const reveal = createShareRevealState<
    'expired' | 'already_viewed' | 'revoked' | 'ineligible' | 'other'
  >()
</script>

{@render children?.()}
{#if error === 'not_found'}
  <p class="text-sm text-slate-700">
    This share link is invalid, or has already expired past recovery.
  </p>
{:else if error === 'session_mismatch'}
  <p class="text-sm text-slate-700">
    This share was not addressed to your account. Ask the sender to confirm the recipient, or sign
    in as the intended recipient.
  </p>
{:else if metadata}
  <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <SharedCredentialSummary
      sharedByLabel={metadata.sharedByEmail ?? 'A teammate'}
      credentialName={metadata.credentialName}
      fieldKey={metadata.fieldKey}
      attributeKeys={metadata.attributeKeys}
      expiresAt={metadata.expiresAt}
      expiryNote={metadata.singleUse ? 'single view only' : 'viewable until expiry'}
    />

    {#if metadata.status !== 'active'}
      <p class="mt-4 text-sm text-red-700">
        This share is no longer active ({metadata.status}).
      </p>
    {:else}
      <ShareRevealContent
        revealedValue={reveal.revealedValue}
        valueFormat={reveal.revealedValueFormat}
        revealError={reveal.revealError}
        revealing={reveal.revealing}
        {onReveal}
        buttonLabel="Reveal"
        expiredMessage="This share has expired."
        alreadyViewedMessage="This share has already been viewed."
        revokedMessage="This share has been revoked."
        otherMessage="Could not reveal this share. Try again."
        ineligibleMessage="You are no longer eligible to view this share."
      />
    {/if}
  </div>
{/if}
