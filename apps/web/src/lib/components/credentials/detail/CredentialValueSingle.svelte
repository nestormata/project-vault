<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { CredentialValueRegionProps } from './credential-value-controller.svelte.js'

  // AC-6: legacy/single-default-field secret — the single reveal button and <pre> block, byte for
  // byte unchanged. Story 69-14: as one replaceable region. The revealed value is the controller's
  // local state and never reaches the point's props or `data`.
  let { controller, pointProps, data }: CredentialValueRegionProps = $props()
</script>

<!-- @region credential.detail.value-single -->
<RegionFragment>
  {#if controller.revealedValue === null}
    <div class="mt-4 flex flex-wrap gap-3">
      <button
        class="rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
        type="button"
        disabled={controller.revealing}
        onclick={() => void controller.revealValue()}
      >
        {controller.revealing ? 'Revealing…' : 'Reveal value'}
      </button>
      <button
        class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-3 text-sm font-medium disabled:opacity-60"
        type="button"
        aria-describedby="credential-copy-help"
        disabled={controller.copyingValue}
        onclick={() => void controller.copyWithoutReveal()}
      >
        {controller.copyingValue
          ? m.credential_copy_legacy_copying()
          : m.credential_copy_legacy_label()}
      </button>
    </div>
    <FormHelpText id="credential-copy-help" text={m.credential_copy_legacy_help()} />
  {:else}
    <pre
      class="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{controller.revealedValue}</pre>
    <div class="mt-3 flex gap-3">
      <button
        class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 text-sm font-medium"
        type="button"
        aria-describedby="credential-copy-revealed-help"
        onclick={() => void controller.copyValue()}
      >
        {m.credential_copy_revealed_label()}
      </button>
      <button
        class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 text-sm font-medium"
        type="button"
        onclick={() => controller.hideValue()}
      >
        Hide
      </button>
    </div>
    {#if controller.revealVersion !== null}
      <p class="mt-2 text-sm text-slate-600">Version {controller.revealVersion}</p>
    {/if}
    <FormHelpText id="credential-copy-revealed-help" text={m.credential_copy_revealed_help()} />
  {/if}
  {#if controller.revealError}
    <p class="mt-3 text-sm text-red-700" role="alert">{controller.revealError}</p>
  {/if}<InjectionPoint name="credential.detail.value-single" props={pointProps} {data} />
</RegionFragment>
