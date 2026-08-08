<script lang="ts">
  import { revealCredentialShare } from '$lib/api/credential-shares.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { mapShareRevealError } from '$lib/api/credential-share-reveal-error.js'
  import SharedCredentialSummary from '$lib/components/credential-shares/SharedCredentialSummary.svelte'
  import ShareRevealContent from '$lib/components/credential-shares/ShareRevealContent.svelte'
  import {
    createShareRevealState,
    revealShareValue,
  } from '$lib/components/credential-shares/reveal-state.svelte.js'

  let { data } = $props()

  // Story 17.1 AC-8: reveal is two-step, never on first request — this only fires on explicit
  // user action (button click), and reuses the existing masked-value/reveal-button visual
  // pattern's spirit (no bespoke second reveal component). 'ineligible' (403) is the one reveal
  // reason unique to this session-bound page — 17.2's external page never sees it.
  const reveal = createShareRevealState<
    'expired' | 'already_viewed' | 'revoked' | 'ineligible' | 'other'
  >()
  async function onReveal(): Promise<void> {
    if (reveal.revealing || !data.metadata) return
    await revealShareValue(
      reveal,
      () => revealCredentialShare(fetch, data.token),
      (error) =>
        error instanceof ApiClientError && error.status === 403
          ? 'ineligible'
          : mapShareRevealError(error)
    )
  }
</script>

<svelte:head>
  <title>Shared credential</title>
</svelte:head>

<section class="mx-auto max-w-lg space-y-6 p-6">
  <h1 class="text-lg font-semibold text-slate-950">Shared credential</h1>

  {#if data.error === 'not_found'}
    <p class="text-sm text-slate-700">
      This share link is invalid, or has already expired past recovery.
    </p>
  {:else if data.error === 'session_mismatch'}
    <p class="text-sm text-slate-700">
      This share was not addressed to your account. Ask the sender to confirm the recipient, or sign
      in as the intended recipient.
    </p>
  {:else if data.metadata}
    <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <SharedCredentialSummary
        sharedByLabel={data.metadata.sharedByEmail ?? 'A teammate'}
        credentialName={data.metadata.credentialName}
        fieldKey={data.metadata.fieldKey}
        attributeKeys={data.metadata.attributeKeys}
        expiresAt={data.metadata.expiresAt}
        expiryNote={data.metadata.singleUse ? 'single view only' : 'viewable until expiry'}
      />

      {#if data.metadata.status !== 'active'}
        <p class="mt-4 text-sm text-red-700">
          This share is no longer active ({data.metadata.status}).
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
</section>
