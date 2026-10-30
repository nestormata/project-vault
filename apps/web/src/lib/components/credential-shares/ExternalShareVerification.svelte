<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'
  import Button from '$lib/components/ui/Button.svelte'
  import Field from '$lib/components/ui/Field.svelte'
  import { TEXT_CONTROL_CLASS } from '$lib/components/ui/control-classes.js'
  import { ExternalShareVerificationController } from './external-share-verification.svelte.js'

  // Story 72.11 AC5/AC6: the recipient's code step. Shows the masked address, asks for the 6-digit
  // code and hands the one-time proof to the parent (kept in memory only).
  let {
    token,
    maskedRecipient,
    onVerified,
  }: {
    token: string
    maskedRecipient: string
    onVerified: (proof: string) => void
  } = $props()

  // Built once per mounted step: the page remounts it for a new token.
  const controller = new ExternalShareVerificationController({
    fetchFn: (...args) => fetch(...args),
    token: untrack(() => token),
    initialMask: untrack(() => maskedRecipient),
    onVerified: (proof) => onVerified(proof),
  })

  onDestroy(() => controller.dispose())

  const errorText = $derived(
    controller.failure === 'failed'
      ? m.guest_verify_failed()
      : controller.failure === 'unavailable'
        ? m.guest_verify_unavailable()
        : undefined
  )
  const resendLabel = $derived(
    controller.cooldownRemaining > 0
      ? m.guest_verify_resend_wait({ seconds: controller.cooldownRemaining })
      : controller.requested
        ? m.guest_verify_resend()
        : m.guest_verify_send()
  )

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void controller.confirm()
  }
</script>

<div class="mt-4 space-y-4">
  <h2 class="text-lg font-semibold text-slate-950">{m.guest_verify_heading()}</h2>
  <p class="text-sm text-slate-700">
    {m.guest_verify_intro({ address: controller.maskedRecipient })}
  </p>

  <Button
    variant={controller.requested ? 'secondary' : 'primary'}
    disabled={!controller.canResend}
    onclick={() => void controller.send()}
  >
    {controller.sending ? m.guest_verify_sending() : resendLabel}
  </Button>

  <p class="text-sm text-slate-700" role="status" aria-live="polite">
    {#if controller.requested}{m.guest_verify_sent({ address: controller.maskedRecipient })}{/if}
  </p>

  <form class="space-y-3" onsubmit={onSubmit}>
    <Field id="guest-verify-code" label={m.guest_verify_code_label()} error={errorText}>
      {#snippet children(wiring)}
        <input
          id="guest-verify-code"
          class={TEXT_CONTROL_CLASS}
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          pattern="[0-9]{'{6}'}"
          bind:value={controller.code}
          aria-invalid={wiring.invalid}
          aria-describedby={wiring.describedBy}
        />
      {/snippet}
    </Field>
    <Button type="submit" disabled={!controller.canConfirm}>
      {controller.confirming ? m.guest_verify_confirming() : m.guest_verify_confirm()}
    </Button>
  </form>
</div>
