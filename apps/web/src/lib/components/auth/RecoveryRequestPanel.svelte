<script lang="ts">
  import type { Snippet } from 'svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { requestRecovery } from '$lib/api/recovery.js'

  let { children }: { children?: Snippet } = $props()

  let isSubmitting = $state(false)
  let email = $state('')
  async function submitForm() {
    if (isSubmitting) return
    isSubmitting = true
    try {
      // AC-9/AC-11: always show the same generic confirmation regardless of the response body,
      // so the UI itself can never leak enumeration info even if a future API change did.
      await requestRecovery(fetch, email)
      submitted = true
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
      if (code === 'native_login_disabled') {
        disabledMessage = NATIVE_LOGIN_DISABLED_MESSAGE
      } else {
        // Rate-limited or transient failure — still show the generic confirmation. A real 4xx
        // here does not tell the caller anything more useful than "try again later," and
        // surfacing the difference would itself be an enumeration/abuse signal.
        submitted = true
      }
    } finally {
      isSubmitting = false
    }
  }
  // Story 23.2 AC-13: native_login_disabled is an INSTANCE-WIDE policy state, not a per-email
  // signal — telling the truth about it leaks nothing about any specific email address, unlike
  // every other failure this form deliberately hides behind GENERIC_MESSAGE. Showing the fake
  // "we've sent a link" confirmation here would be an outright fabricated success (AC-13's
  // "never a fabricated success" line) — no token was minted, no email was queued.
  const NATIVE_LOGIN_DISABLED_MESSAGE =
    'This vault is configured for external sign-in; password recovery is not available. Contact your administrator.'
  let disabledMessage = $state<string | null>(null)
  let submitted = $state(false)
  const GENERIC_MESSAGE = "If that email is registered, we've sent a recovery link."
</script>

{#if disabledMessage}
  <p class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-700" role="status">
    {disabledMessage}
  </p>
{:else if submitted}
  <p class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-700" role="status">
    {GENERIC_MESSAGE}
  </p>
{:else}
  <form
    class="space-y-5"
    onsubmit={(event) => {
      event.preventDefault()
      void submitForm()
    }}
  >
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="recovery-email">Email</label>
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="recovery-email"
        type="email"
        autocomplete="email"
        aria-describedby="recovery-email-help"
        bind:value={email}
        required
      />
      <FormHelpText id="recovery-email-help" kind="text" />
    </div>
    <button
      class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      type="submit"
      disabled={isSubmitting}
    >
      {isSubmitting ? 'Sending...' : 'Send recovery link'}
    </button>
  </form>
{/if}
{@render children?.()}
