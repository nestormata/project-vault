<script lang="ts">
  import RecoveryMfaSetup from './RecoveryMfaSetup.svelte'
  import RecoveryPasswordField from './RecoveryPasswordField.svelte'
  import type { RecoveryReset } from './recovery-reset.svelte.js'

  // Story 69.14: the heading, the error banner and the form of a usable recovery link. The form
  // shell only wires the password and MFA regions to the recovery state owned by the page content.
  let {
    flow,
    data,
  }: { flow: RecoveryReset; data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<div class="space-y-2">
  <h1 class="text-2xl font-bold">Set a new password</h1>
  <p class="text-slate-600">Choose a new password for your account.</p>
</div>

{#if flow.errorMessage}
  <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
    {flow.errorMessage}
  </p>
{/if}

<form
  method="post"
  class="space-y-5"
  onsubmit={(event) => {
    event.preventDefault()
    void flow.submit()
  }}
>
  <RecoveryPasswordField bind:value={flow.newPassword} {data} />

  <RecoveryMfaSetup {flow} {data} />

  <button
    class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
    type="submit"
    disabled={flow.isSubmitting}
  >
    {flow.isSubmitting ? 'Resetting...' : 'Reset password'}
  </button>
</form>
