<script>
  import { buildVaultInitRequest, clearVaultInitFields } from './form-model.js'

  let { onSubmit } = $props()
  let mode = $state('passphrase')
  let bootstrapToken = $state('')
  let passphrase = $state('')
  let envelopeKeyPath = $state('')
  let masterKeyPath = $state('')
  let acknowledgeSplitKeyModel = $state(false)
  let acknowledgeCoLocationRisk = $state(false)
  let errorMessage = $state(null)
  let isSubmitting = $state(false)

  function currentFields() {
    return { bootstrapToken, mode, passphrase, envelopeKeyPath, masterKeyPath }
  }

  function clearSensitiveFields() {
    const cleared = clearVaultInitFields(currentFields())
    bootstrapToken = cleared.bootstrapToken
    passphrase = cleared.passphrase
    envelopeKeyPath = cleared.envelopeKeyPath
    masterKeyPath = cleared.masterKeyPath
  }

  async function submitForm() {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    const fields = currentFields()
    const request = buildVaultInitRequest(fields)
    const token = bootstrapToken
    try {
      await onSubmit?.(request, token)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Vault initialization failed.'
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
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="vault-bootstrap-token"
      >Bootstrap token</label
    >
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="vault-bootstrap-token"
      name="bootstrapToken"
      type="password"
      autocomplete="off"
      bind:value={bootstrapToken}
      required
    />
    <p class="text-sm text-slate-600">
      This operator token is configured on the vault host and is sent only as a request header.
    </p>
  </div>

  <fieldset class="space-y-3">
    <legend class="font-medium text-slate-900">Initialization mode</legend>
    <label class="flex items-center gap-2">
      <input type="radio" name="kmsType" value="passphrase" bind:group={mode} />
      <span>Passphrase</span>
    </label>
    <label class="flex items-center gap-2">
      <input type="radio" name="kmsType" value="envelope" bind:group={mode} />
      <span>Envelope key path</span>
    </label>
    <label class="flex items-center gap-2">
      <input type="radio" name="kmsType" value="file" bind:group={mode} />
      <span>Master key file path</span>
    </label>
  </fieldset>

  {#if mode === 'passphrase'}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="vault-init-passphrase"
        >Vault passphrase</label
      >
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="vault-init-passphrase"
        name="passphrase"
        type="password"
        autocomplete="new-password"
        bind:value={passphrase}
        required
      />
      <p class="text-sm text-slate-600">
        The vault key is derived from this passphrase. Losing it can make stored secrets
        unrecoverable.
      </p>
    </div>
  {:else if mode === 'envelope'}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="vault-envelope-key-path"
        >Envelope key path</label
      >
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="vault-envelope-key-path"
        name="envelopeKeyPath"
        type="text"
        autocomplete="off"
        bind:value={envelopeKeyPath}
        required
      />
      <p class="text-sm text-slate-600">
        The API reads this path on the server host, inside the configured key directory. The browser
        never uploads the file.
      </p>
      <label class="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" bind:checked={acknowledgeSplitKeyModel} required />
        <span>I understand the split-key model for envelope mode.</span>
      </label>
    </div>
  {:else}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="vault-master-key-path"
        >Master key path</label
      >
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="vault-master-key-path"
        name="masterKeyPath"
        type="text"
        autocomplete="off"
        bind:value={masterKeyPath}
        required
      />
      <p class="text-sm text-slate-600">
        File mode keeps key material near the vault host. It is not recommended for production
        without host hardening.
      </p>
      <label class="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" bind:checked={acknowledgeCoLocationRisk} required />
        <span>I understand the key co-location risk for file mode.</span>
      </label>
    </div>
  {/if}

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
    {isSubmitting ? 'Initializing vault...' : 'Initialize vault'}
  </button>
</form>
