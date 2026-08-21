<script lang="ts">
  import { revealExternalCredentialShare } from '$lib/api/credential-shares.js'
  import { mapShareRevealError } from '$lib/api/credential-share-reveal-error.js'
  import SharedCredentialSummary from '$lib/components/credential-shares/SharedCredentialSummary.svelte'
  import ShareRevealContent from '$lib/components/credential-shares/ShareRevealContent.svelte'
  import {
    createShareRevealState,
    revealShareValue,
  } from '$lib/components/credential-shares/reveal-state.svelte.js'

  let { data } = $props()

  // Story 17.2 AC-9: two-step reveal, never on first request — this only fires on Priya's
  // explicit "Reveal secret" button click, mirroring 17.1's own reveal-page pattern. Unlike
  // 17.1's session-bound page, this unauthenticated path never produces the 'ineligible' reason.
  const reveal = createShareRevealState<'expired' | 'already_viewed' | 'revoked' | 'other'>()
  async function onReveal(): Promise<void> {
    if (reveal.revealing || !data.metadata) return
    await revealShareValue(
      reveal,
      () => revealExternalCredentialShare(fetch, data.token),
      mapShareRevealError
    )
  }
</script>

<svelte:head>
  <title>Shared secret</title>
</svelte:head>

<!--
  Story 17.2 AC-10 (F1): no third-party-origin resources anywhere on this page — no external
  images/fonts/scripts/analytics/embeds. Referrer-Policy alone only governs this page's own
  outbound requests; a same-origin-only resource set is the only way to guarantee zero leak
  surface for the token-bearing URL.
-->
<section class="mx-auto max-w-lg space-y-6 p-6">
  <h1 class="text-lg font-semibold text-slate-950">Shared secret</h1>

  {#if data.error === 'not_found'}
    <p class="text-sm text-slate-700">
      This link is invalid, has expired, or has already been used.
    </p>
  {:else if data.error === 'unavailable'}
    <p class="text-sm text-slate-700">
      This link couldn't be checked right now. Please try again in a moment.
    </p>
  {:else if data.metadata}
    <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <SharedCredentialSummary
        sharedByLabel={data.metadata.sharedByDisplayName}
        credentialName={data.metadata.credentialName}
        fieldKey={data.metadata.fieldKey}
        attributeKeys={data.metadata.attributeKeys}
        expiresAt={data.metadata.expiresAt}
        expiryNote="single view only"
      />

      {#if data.metadata.status !== 'active'}
        <p class="mt-4 text-sm text-red-700">This link is no longer active.</p>
      {:else}
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
</section>
