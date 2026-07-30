<script lang="ts">
  import { revealExternalCredentialShare } from '$lib/api/credential-shares.js'
  import { mapShareRevealError } from '$lib/api/credential-share-reveal-error.js'
  import SharedCredentialSummary from '$lib/components/credential-shares/SharedCredentialSummary.svelte'
  import RevealedShareValue from '$lib/components/credential-shares/RevealedShareValue.svelte'
  import { createShareRevealState } from '$lib/components/credential-shares/reveal-state.svelte.js'

  let { data } = $props()

  // Story 17.2 AC-9: two-step reveal, never on first request — this only fires on Priya's
  // explicit "Reveal secret" button click, mirroring 17.1's own reveal-page pattern. Unlike
  // 17.1's session-bound page, this unauthenticated path never produces the 'ineligible' reason.
  const reveal = createShareRevealState<'expired' | 'already_viewed' | 'revoked' | 'other'>()

  async function onReveal(): Promise<void> {
    if (reveal.revealing || !data.metadata) return
    reveal.revealing = true
    reveal.revealError = null
    try {
      const result = await revealExternalCredentialShare(fetch, data.token)
      reveal.revealedValue = result.value
    } catch (error) {
      reveal.revealError = mapShareRevealError(error)
    } finally {
      reveal.revealing = false
    }
  }
</script>

<svelte:head>
  <title>Shared credential</title>
</svelte:head>

<!--
  Story 17.2 AC-10 (F1): no third-party-origin resources anywhere on this page — no external
  images/fonts/scripts/analytics/embeds. Referrer-Policy alone only governs this page's own
  outbound requests; a same-origin-only resource set is the only way to guarantee zero leak
  surface for the token-bearing URL.
-->
<section class="mx-auto max-w-lg space-y-6 p-6">
  <h1 class="text-lg font-semibold text-slate-950">Shared credential</h1>

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
        expiresAt={data.metadata.expiresAt}
        expiryNote="single view only"
      />

      {#if data.metadata.status !== 'active'}
        <p class="mt-4 text-sm text-red-700">This link is no longer active.</p>
      {:else if reveal.revealedValue !== null}
        <RevealedShareValue value={reveal.revealedValue} />
      {:else if reveal.revealError === 'already_viewed'}
        <p class="mt-4 text-sm text-red-700">This link has already been used.</p>
      {:else if reveal.revealError === 'revoked'}
        <p class="mt-4 text-sm text-red-700">This link has been revoked.</p>
      {:else if reveal.revealError === 'expired'}
        <p class="mt-4 text-sm text-red-700">This link has expired.</p>
      {:else}
        {#if reveal.revealError === 'other'}
          <p class="mt-4 text-sm text-red-700">Could not reveal this secret. Try again.</p>
        {/if}
        <button
          type="button"
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={reveal.revealing}
          onclick={onReveal}
        >
          {reveal.revealing ? 'Revealing…' : 'Reveal secret'}
        </button>
      {/if}
    </div>
  {/if}
</section>
