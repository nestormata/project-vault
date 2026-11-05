<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'
  import TextField from '$lib/components/ui/TextField.svelte'
  import { cliDeviceOutcomeMessageKey } from '$lib/cli-device-code.js'

  function outcomeText(code: string | undefined): string {
    switch (cliDeviceOutcomeMessageKey(code)) {
      case 'cli_device_approved':
        return m.cli_device_approved()
      case 'cli_device_denied':
        return m.cli_device_denied()
      case 'cli_device_invalid_code':
        return m.cli_device_invalid_code()
      case 'cli_device_step_up_required':
        return m.cli_device_step_up_required()
      case 'cli_device_enrollment_required':
        return m.cli_device_enrollment_required()
      default:
        return m.cli_device_error()
    }
  }

  let {
    code = '',
    isPlatformOperator,
    outcome,
    children,
  }: {
    code?: string
    isPlatformOperator: boolean
    outcome?: string
    children?: Snippet
  } = $props()

  let userCode = $state(untrack(() => code))
  let totpCode = $state('')
</script>

<h1 class="text-2xl font-bold text-slate-900">{m.cli_device_heading()}</h1>
<p class="mt-2 text-slate-600">{m.cli_device_description()}</p>

{#if outcome}
  <p class="mt-4 text-slate-800" role="status">{outcomeText(outcome)}</p>
{/if}

<form class="mt-6 space-y-4" method="POST" action="?/decide">
  <TextField
    id="cli-device-code"
    name="userCode"
    label={m.cli_device_code_label()}
    hint={m.cli_device_code_hint()}
    bind:value={userCode}
    required
    autocomplete="off"
  />
  {#if isPlatformOperator}
    <TextField
      id="cli-device-totp"
      name="totpCode"
      label={m.cli_device_totp_label()}
      hint={m.cli_device_totp_hint()}
      bind:value={totpCode}
      autocomplete="one-time-code"
    />
  {/if}
  <div class="flex gap-3">
    <button
      class="rounded bg-slate-900 px-4 py-2 text-white"
      type="submit"
      name="decision"
      value="approve">{m.cli_device_approve()}</button
    >
    <button
      class="rounded border border-[color:var(--color-border-strong,#64748b)] px-4 py-2"
      type="submit"
      name="decision"
      value="deny">{m.cli_device_deny()}</button
    >
  </div>
</form>
{@render children?.()}
