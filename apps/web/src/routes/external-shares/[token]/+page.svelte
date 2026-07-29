<script lang="ts">
  import { revealExternalCredentialShare } from '$lib/api/credential-shares.js'
  import { ApiClientError } from '$lib/api/client.js'

  let { data } = $props()

  // Story 17.2 AC-9: two-step reveal, never on first request — this only fires on Priya's
  // explicit "Reveal secret" button click, mirroring 17.1's own reveal-page pattern.
  let revealing = $state(false)
  let revealedValue = $state<string | null>(null)
  let revealError = $state<'expired' | 'already_viewed' | 'revoked' | 'other' | null>(null)

  async function onReveal(): Promise<void> {
    if (revealing || !data.metadata) return
    revealing = true
    revealError = null
    try {
      const result = await revealExternalCredentialShare(fetch, data.token)
      revealedValue = result.value
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        revealError =
          error.code === 'share_already_viewed'
            ? 'already_viewed'
            : error.code === 'share_revoked'
              ? 'revoked'
              : 'expired'
      } else {
        revealError = 'other'
      }
    } finally {
      revealing = false
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
  {:else if data.metadata}
    <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm text-slate-700">
        <strong>{data.metadata.sharedByDisplayName}</strong> shared
        <strong>{data.metadata.credentialName}</strong>{data.metadata.fieldKey
          ? ` (field: ${data.metadata.fieldKey})`
          : ''} with you.
      </p>
      <p class="mt-2 text-xs text-slate-500">
        Expires {new Date(data.metadata.expiresAt).toLocaleString()} · single view only
      </p>

      {#if data.metadata.status !== 'active'}
        <p class="mt-4 text-sm text-red-700">This link is no longer active.</p>
      {:else if revealedValue !== null}
        <div class="mt-4">
          <p class="mb-1 text-sm font-medium text-slate-700">Value</p>
          <code class="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-900">
            {revealedValue}
          </code>
        </div>
      {:else if revealError === 'already_viewed'}
        <p class="mt-4 text-sm text-red-700">This link has already been used.</p>
      {:else if revealError === 'revoked'}
        <p class="mt-4 text-sm text-red-700">This link has been revoked.</p>
      {:else if revealError === 'expired'}
        <p class="mt-4 text-sm text-red-700">This link has expired.</p>
      {:else}
        {#if revealError === 'other'}
          <p class="mt-4 text-sm text-red-700">Could not reveal this secret. Try again.</p>
        {/if}
        <button
          type="button"
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={revealing}
          onclick={onReveal}
        >
          {revealing ? 'Revealing…' : 'Reveal secret'}
        </button>
      {/if}
    </div>
  {/if}
</section>
