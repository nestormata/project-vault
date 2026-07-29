<script lang="ts">
  import { revealCredentialShare } from '$lib/api/credential-shares.js'
  import { ApiClientError } from '$lib/api/client.js'

  let { data } = $props()

  // Story 17.1 AC-8: reveal is two-step, never on first request — this only fires on explicit
  // user action (button click), and reuses the existing masked-value/reveal-button visual
  // pattern's spirit (no bespoke second reveal component).
  let revealing = $state(false)
  let revealedValue = $state<string | null>(null)
  let revealError = $state<
    'expired' | 'already_viewed' | 'revoked' | 'ineligible' | 'other' | null
  >(null)

  async function onReveal(): Promise<void> {
    if (revealing || !data.metadata) return
    revealing = true
    revealError = null
    try {
      const result = await revealCredentialShare(fetch, data.token)
      revealedValue = result.value
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        revealError =
          error.code === 'share_already_viewed'
            ? 'already_viewed'
            : error.code === 'share_revoked'
              ? 'revoked'
              : 'expired'
      } else if (error instanceof ApiClientError && error.status === 403) {
        revealError = 'ineligible'
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
      <p class="text-sm text-slate-700">
        <strong>{data.metadata.sharedByEmail ?? 'A teammate'}</strong> shared
        <strong>{data.metadata.credentialName}</strong>{data.metadata.fieldKey
          ? ` (field: ${data.metadata.fieldKey})`
          : ''} with you.
      </p>
      <p class="mt-2 text-xs text-slate-500">
        Expires {new Date(data.metadata.expiresAt).toLocaleString()} ·
        {data.metadata.singleUse ? 'single view only' : 'viewable until expiry'}
      </p>

      {#if data.metadata.status !== 'active'}
        <p class="mt-4 text-sm text-red-700">
          This share is no longer active ({data.metadata.status}).
        </p>
      {:else if revealedValue !== null}
        <div class="mt-4">
          <p class="mb-1 text-sm font-medium text-slate-700">Value</p>
          <code class="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-900">
            {revealedValue}
          </code>
        </div>
      {:else if revealError === 'already_viewed'}
        <p class="mt-4 text-sm text-red-700">This share has already been viewed.</p>
      {:else if revealError === 'revoked'}
        <p class="mt-4 text-sm text-red-700">This share has been revoked.</p>
      {:else if revealError === 'expired'}
        <p class="mt-4 text-sm text-red-700">This share has expired.</p>
      {:else if revealError === 'ineligible'}
        <p class="mt-4 text-sm text-red-700">You are no longer eligible to view this share.</p>
      {:else}
        {#if revealError === 'other'}
          <p class="mt-4 text-sm text-red-700">Could not reveal this share. Try again.</p>
        {/if}
        <button
          type="button"
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={revealing}
          onclick={onReveal}
        >
          {revealing ? 'Revealing…' : 'Reveal'}
        </button>
      {/if}
    </div>
  {/if}
</section>
