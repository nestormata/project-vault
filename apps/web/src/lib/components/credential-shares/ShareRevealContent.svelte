<script lang="ts">
  import type { ShareRevealValueFormat } from '$lib/api/credential-shares.js'
  import type { ShareRevealErrorReason } from '$lib/api/credential-share-reveal-error.js'
  import RevealedShareValue from './RevealedShareValue.svelte'

  type RevealError = ShareRevealErrorReason | 'ineligible' | null

  type Props = {
    revealedValue: string | null
    valueFormat: ShareRevealValueFormat
    revealError: RevealError
    revealing: boolean
    onReveal: () => void | Promise<void>
    buttonLabel: string
    expiredMessage: string
    alreadyViewedMessage: string
    revokedMessage: string
    otherMessage: string
    ineligibleMessage?: string
  }

  let {
    revealedValue,
    valueFormat,
    revealError,
    revealing,
    onReveal,
    buttonLabel,
    expiredMessage,
    alreadyViewedMessage,
    revokedMessage,
    otherMessage,
    ineligibleMessage,
  }: Props = $props()
</script>

{#if revealedValue !== null}
  <RevealedShareValue value={revealedValue} {valueFormat} />
{:else if revealError === 'already_viewed'}
  <p class="mt-4 text-sm text-red-700">{alreadyViewedMessage}</p>
{:else if revealError === 'revoked'}
  <p class="mt-4 text-sm text-red-700">{revokedMessage}</p>
{:else if revealError === 'expired'}
  <p class="mt-4 text-sm text-red-700">{expiredMessage}</p>
{:else if revealError === 'ineligible' && ineligibleMessage}
  <p class="mt-4 text-sm text-red-700">{ineligibleMessage}</p>
{:else}
  {#if revealError === 'other'}
    <p class="mt-4 text-sm text-red-700">{otherMessage}</p>
  {/if}
  <button
    type="button"
    class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
    disabled={revealing}
    onclick={onReveal}
  >
    {revealing ? 'Revealing…' : buttonLabel}
  </button>
{/if}
