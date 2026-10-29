<!--
  @pv-stable: the props contract ({ open, id, title, message, confirmLabel, cancelLabel, variant,
  typedValue, typedLabel, pending, onconfirm, oncancel }) is final (Story 72.5). A confirmation on
  the shared `Dialog`: Cancel holds the initial focus (the safe choice), Escape and the backdrop
  cancel, and with `typedValue` the confirm button stays disabled until the caller types it exactly
  (the existing `TypedConfirmInput` comparison: trimmed, case-insensitive).
-->
<script lang="ts">
  import TypedConfirmInput from '$lib/components/forms/TypedConfirmInput.svelte'
  import Button from './Button.svelte'
  import Dialog from './Dialog.svelte'

  let {
    open = $bindable(false),
    id,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'primary',
    typedValue,
    typedLabel,
    pending = false,
    onconfirm,
    oncancel,
  }: {
    open?: boolean
    id: string
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    variant?: 'primary' | 'danger'
    /** When set, the caller must type this value before Confirm enables. */
    typedValue?: string
    typedLabel?: string
    pending?: boolean
    onconfirm: () => void | Promise<void>
    oncancel?: () => void
  } = $props()

  let typedMatches = $state(false)
  let confirmed = false

  const canConfirm = $derived(!pending && (typedValue === undefined || typedMatches))

  async function handleConfirm() {
    if (!canConfirm) return
    confirmed = true
    await onconfirm()
    open = false
  }

  function handleClose() {
    // Reached for Escape, the backdrop, Cancel and the close that follows a confirm.
    const wasConfirmed = confirmed
    confirmed = false
    typedMatches = false
    if (!wasConfirmed) oncancel?.()
  }
</script>

<Dialog bind:open {id} {title} description={message} onclose={handleClose}>
  {#if open && typedValue !== undefined}
    <TypedConfirmInput
      expectedValue={typedValue}
      onMatchChange={(matches) => (typedMatches = matches)}
      label={typedLabel ?? 'Type the exact name to confirm'}
      inputId={`${id}-typed`}
    />
  {/if}
  {#snippet footer()}
    <span data-autofocus>
      <Button variant="secondary" onclick={() => (open = false)}>{cancelLabel}</Button>
    </span>
    <Button {variant} disabled={!canConfirm} onclick={() => void handleConfirm()}>
      {confirmLabel}
    </Button>
  {/snippet}
</Dialog>
