<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { CredentialValueRegionProps } from './credential-value-controller.svelte.js'
  import CredentialValueFieldRow from './CredentialValueFieldRow.svelte'

  // Story 13.3 AC-1/2/3 — per-field interactive rows of a multi-field secret: non-sensitive fields
  // show their value inline (from the eager `visibleFieldValues`, no click); sensitive fields show a
  // masked placeholder plus their own "Reveal" button. Visible to anyone who can view the secret at
  // all (viewer role) — only the Reveal/Reveal-all buttons themselves are gated by canReveal
  // (member+). Story 69-14: the rows and "Reveal all" as one replaceable region.
  let { controller, pointProps, data }: CredentialValueRegionProps = $props()
</script>

<!-- @region credential.detail.value-fields -->
<RegionFragment>
  <ul class="mt-3 space-y-1" data-testid="field-list">
    {#each controller.fieldMeta as meta (meta.key)}
      <CredentialValueFieldRow {controller} {meta} />
    {/each}
  </ul>
  {#if controller.canReveal}
    <FormHelpText id="credential-reveal-fields-help" text={m.credential_reveal_auto_hide_help()} />
    <FormHelpText
      id="credential-copy-fields-clipboard-note"
      text={m.credential_copy_fields_clipboard_note()}
    />
    <button
      class="mt-3 rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 text-sm font-medium disabled:opacity-60"
      type="button"
      disabled={controller.revealAllLoading}
      onclick={() => void controller.revealAllFields()}
    >
      {controller.revealAllLoading ? 'Revealing all…' : 'Reveal all'}
    </button>
    {#if controller.revealAllError}
      <p class="mt-2 text-sm text-red-700" role="alert">{controller.revealAllError}</p>
    {/if}
  {/if}<InjectionPoint name="credential.detail.value-fields" props={pointProps} {data} />
</RegionFragment>
