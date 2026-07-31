<script>
  import { buildVaultUnsealRequest, clearVaultUnsealFields } from './form-model.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  let { onSubmit } = $props()
  let mode = $state('passphrase')
  let passphrase = $state('')
  let envelopeKeyPath = $state('')
  let masterKeyPath = $state('')
  let errorMessage = $state(null)
  let isSubmitting = $state(false)

  function currentFields() {
    return { mode, passphrase, envelopeKeyPath, masterKeyPath }
  }

  function clearSensitiveFields() {
    const cleared = clearVaultUnsealFields(currentFields())
    passphrase = cleared.passphrase
    envelopeKeyPath = cleared.envelopeKeyPath
    masterKeyPath = cleared.masterKeyPath
  }

  async function submitForm() {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    const request = buildVaultUnsealRequest(currentFields())
    try {
      await onSubmit?.(request)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Vault unseal failed.'
    } finally {
      clearSensitiveFields()
      isSubmitting = false
    }
  }
</script>

<form
  class="space-y-5"
  onsubmit={(event) => {
    event.preventDefault()
    void submitForm()
  }}
>
  <fieldset class="space-y-3">
    <legend class="font-medium text-slate-900">Unseal material</legend>
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="unsealMode"
        value="passphrase"
        bind:group={mode}
        aria-describedby="vault-unseal-mode-help"
      />
      <span>Passphrase</span>
    </label>
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="unsealMode"
        value="envelopeKeyPath"
        bind:group={mode}
        aria-describedby="vault-unseal-mode-help"
      />
      <span>Envelope key file</span>
    </label>
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="unsealMode"
        value="masterKeyPath"
        bind:group={mode}
        aria-describedby="vault-unseal-mode-help"
      />
      <span>Master key file</span>
    </label>
  </fieldset>
  <FormHelpText id="vault-unseal-mode-help" kind="radio" />

  {#if mode === 'passphrase'}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="vault-unseal-passphrase"
        >Vault passphrase</label
      >
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="vault-unseal-passphrase"
        name="passphrase"
        type="password"
        autocomplete="current-password"
        bind:value={passphrase}
        required
        aria-describedby="vault-unseal-passphrase-help"
      />
      <FormHelpText id="vault-unseal-passphrase-help" kind="secret" />
    </div>
  {:else if mode === 'envelopeKeyPath'}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="vault-unseal-envelope-path"
        >Envelope key file path</label
      >
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="vault-unseal-envelope-path"
        name="envelopeKeyPath"
        type="text"
        autocomplete="off"
        bind:value={envelopeKeyPath}
        required
        aria-describedby="vault-unseal-envelope-path-help"
      />
      <FormHelpText id="vault-unseal-envelope-path-help" kind="text" />
    </div>
  {:else}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="vault-unseal-master-path"
        >Master key file path</label
      >
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="vault-unseal-master-path"
        name="masterKeyPath"
        type="text"
        autocomplete="off"
        bind:value={masterKeyPath}
        required
        aria-describedby="vault-unseal-master-path-help"
      />
      <FormHelpText id="vault-unseal-master-path-help" kind="text" />
    </div>
  {/if}

  <p class="text-sm text-slate-600">
    The path is read by the API server from the vault host. Do not paste secret file contents here.
  </p>

  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}

  <button
    class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
    type="submit"
    disabled={isSubmitting}
  >
    {isSubmitting ? 'Unsealing vault...' : 'Unseal vault'}
  </button>
</form>
