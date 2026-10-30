<script lang="ts">
  import type { FieldMeta } from '@project-vault/shared'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { isMainField } from '$lib/credentials/credential-detail-helpers.js'
  import type { CredentialValueController } from './credential-value-controller.svelte.js'
  import CredentialValueTotpField from './CredentialValueTotpField.svelte'

  // Story 69-14: one field of a multi-field secret (its value, mask or reveal control, and copy
  // button) plus the inline error of a failed per-field reveal. A helper of the fields region, so it
  // carries no region of its own; the state it reads and writes is the controller's.
  let {
    controller,
    meta,
  }: {
    controller: CredentialValueController
    meta: FieldMeta
  } = $props()

  const eagerValue = $derived(
    !meta.sensitive && Object.hasOwn(controller.visibleFieldValues, meta.key)
      ? controller.visibleFieldValues[meta.key]
      : undefined
  )
  const revealedFieldValue = $derived(
    Object.hasOwn(controller.revealedFields, meta.key)
      ? controller.revealedFields[meta.key]
      : undefined
  )
  const fieldError = $derived(
    Object.hasOwn(controller.fieldRevealError, meta.key)
      ? controller.fieldRevealError[meta.key]
      : undefined
  )
  const totpError = $derived(
    Object.hasOwn(controller.totpError, meta.key) ? controller.totpError[meta.key] : undefined
  )
  // Story 72.10: a multiline value keeps its line breaks when shown.
  const valueClass = $derived(
    meta.kind === 'multiline'
      ? 'whitespace-pre-wrap break-words font-mono text-slate-700'
      : 'font-mono text-slate-700'
  )
  const isCopyingField = $derived(controller.copyingFields.has(meta.key))
  const copyHelpId = $derived(`credential-copy-help-${encodeURIComponent(meta.key)}`)
</script>

<li
  class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"
  data-testid={`field-row-${meta.key}`}
>
  <div class="min-w-0">
    <span class="font-medium text-slate-900">{meta.key}</span>
    {#if isMainField(meta)}
      <span class="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700"
        >{m.credential_field_main_badge()}</span
      >
    {/if}
    {#if controller.canReveal && meta.kind === 'totp'}
      <FormHelpText id={copyHelpId} text={m.credential_totp_help()} />
    {:else if controller.canReveal}
      <FormHelpText id={copyHelpId} text={m.credential_copy_field_help({ field: meta.key })} />
    {/if}
  </div>
  <div class="flex items-center gap-2">
    {#if meta.kind === 'totp'}
      <CredentialValueTotpField {controller} {meta} />
    {:else if eagerValue !== undefined}
      <span class={valueClass} data-testid={`field-value-${meta.key}`}>{eagerValue}</span>
    {:else if revealedFieldValue !== undefined}
      <span class={valueClass} data-testid={`field-value-${meta.key}`}>{revealedFieldValue}</span>
      {#if controller.canReveal}
        <button
          class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs font-medium"
          type="button"
          onclick={() => controller.hideField(meta.key)}
        >
          Hide
        </button>
        <button
          class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs font-medium disabled:opacity-60"
          type="button"
          disabled={controller.revealingField === meta.key}
          onclick={() => void controller.extendField(meta.key)}
        >
          {m.credential_reveal_extend_field({ field: meta.key })}
        </button>
      {/if}
    {:else}
      <span class="text-slate-400" data-testid={`field-masked-${meta.key}`}>••••••••</span>
      {#if controller.canReveal}
        <button
          class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs font-medium disabled:opacity-60"
          type="button"
          disabled={controller.revealingField === meta.key}
          onclick={() => void controller.revealSingleField(meta.key)}
        >
          {controller.revealingField === meta.key ? 'Revealing…' : 'Reveal'}
        </button>
      {/if}
    {/if}
    {#if controller.canReveal && meta.kind !== 'totp'}
      <button
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs font-medium disabled:opacity-60"
        type="button"
        aria-describedby={copyHelpId}
        disabled={isCopyingField}
        onclick={() => void controller.copyWithoutReveal(meta.key)}
      >
        {isCopyingField
          ? m.credential_copy_field_copying({ field: meta.key })
          : m.credential_copy_field_label({ field: meta.key })}
      </button>
    {/if}
  </div>
</li>
{#if fieldError}
  <p class="text-sm text-red-700" role="alert">{fieldError}</p>
{/if}
{#if totpError}
  <p class="text-sm text-red-700" role="alert">{totpError}</p>
{/if}
