<script lang="ts">
  import { resolve } from '$app/paths'
  import { requestRecovery } from '$lib/api/recovery.js'

  const GENERIC_MESSAGE = "If that email is registered, we've sent a recovery link."

  let email = $state('')
  let isSubmitting = $state(false)
  let submitted = $state(false)

  async function submitForm() {
    if (isSubmitting) return
    isSubmitting = true
    try {
      // AC-9/AC-11: always show the same generic confirmation regardless of the response body,
      // so the UI itself can never leak enumeration info even if a future API change did.
      await requestRecovery(fetch, email)
    } catch {
      // Rate-limited or transient failure — still show the generic confirmation. A real 4xx here
      // does not tell the caller anything more useful than "try again later," and surfacing the
      // difference would itself be an enumeration/abuse signal.
    } finally {
      isSubmitting = false
      submitted = true
    }
  }
</script>

<svelte:head>
  <title>Recover your account | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  <div class="space-y-2">
    <h1 class="text-3xl font-bold">Recover your account</h1>
    <p class="text-slate-600">Enter your email and we'll send you a link to reset your password.</p>
  </div>

  {#if submitted}
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
          bind:value={email}
          required
        />
      </div>
      <button
        class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={isSubmitting}
      >
        {isSubmitting ? 'Sending...' : 'Send recovery link'}
      </button>
    </form>
  {/if}

  <p class="text-sm text-slate-600">
    Remembered your password? <a
      class="font-medium text-slate-950 underline"
      href={resolve('/login')}>Sign in</a
    >
  </p>
</div>
