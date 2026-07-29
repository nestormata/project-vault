<script lang="ts">
  import { revealCredentialShare } from '$lib/api/credential-shares.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { mapShareRevealError } from '$lib/api/credential-share-reveal-error.js'
  import SharedCredentialSummary from '$lib/components/credential-shares/SharedCredentialSummary.svelte'
  import RevealedShareValue from '$lib/components/credential-shares/RevealedShareValue.svelte'
  import { createShareRevealState } from '$lib/components/credential-shares/reveal-state.svelte.js'

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
    reveal.revealing = true
    reveal.revealError = null
    try {
      const result = await revealCredentialShare(fetch, data.token)
      reveal.revealedValue = result.value
    } catch (error) {
      reveal.revealError =
        error instanceof ApiClientError && error.status === 403
          ? 'ineligible'
          : mapShareRevealError(error)
    } finally {
      reveal.revealing = false
    }
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
        expiresAt={data.metadata.expiresAt}
        expiryNote={data.metadata.singleUse ? 'single view only' : 'viewable until expiry'}
      />

      {#if data.metadata.status !== 'active'}
        <p class="mt-4 text-sm text-red-700">
          This share is no longer active ({data.metadata.status}).
        </p>
      {:else if reveal.revealedValue !== null}
        <RevealedShareValue value={reveal.revealedValue} />
      {:else if reveal.revealError === 'already_viewed'}
        <p class="mt-4 text-sm text-red-700">This share has already been viewed.</p>
      {:else if reveal.revealError === 'revoked'}
        <p class="mt-4 text-sm text-red-700">This share has been revoked.</p>
      {:else if reveal.revealError === 'expired'}
        <p class="mt-4 text-sm text-red-700">This share has expired.</p>
      {:else if reveal.revealError === 'ineligible'}
        <p class="mt-4 text-sm text-red-700">You are no longer eligible to view this share.</p>
      {:else}
        {#if reveal.revealError === 'other'}
          <p class="mt-4 text-sm text-red-700">Could not reveal this share. Try again.</p>
        {/if}
        <button
          type="button"
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={reveal.revealing}
          onclick={onReveal}
        >
          {reveal.revealing ? 'Revealing…' : 'Reveal'}
        </button>
      {/if}
    </div>
  {/if}
</section>
