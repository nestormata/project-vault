<script lang="ts">
  import CredentialRotateActions from './CredentialRotateActions.svelte'
  import CredentialRotateError from './CredentialRotateError.svelte'
  import CredentialRotateFields from './CredentialRotateFields.svelte'
  import CredentialRotateFieldValues from './CredentialRotateFieldValues.svelte'
  import CredentialRotateNotes from './CredentialRotateNotes.svelte'
  import CredentialRotateSameValueConfirm from './CredentialRotateSameValueConfirm.svelte'
  import CredentialRotateValue from './CredentialRotateValue.svelte'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the start-rotation `<form>` and the order of its sections. Each section is a
  // sub-region; all of them read and write the one controller the page component created.
  let {
    form,
    projectId,
    credentialId,
    data,
  }: {
    form: RotateFormController
    projectId: string
    credentialId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<form
  class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
  onsubmit={(event) => {
    event.preventDefault()
    void form.submitForm()
  }}
>
  {#if form.showFieldSelector}
    <CredentialRotateFields {form} {data} />
  {/if}

  {#if form.multiFieldValueMode}
    <CredentialRotateFieldValues {form} {data} />
  {:else}
    <CredentialRotateValue {form} {data} />
  {/if}

  <CredentialRotateNotes {form} {data} />

  {#if form.showSameValueConfirm}
    <CredentialRotateSameValueConfirm {form} {data} />
  {/if}

  {#if form.errorMessage}
    <CredentialRotateError {form} {projectId} {credentialId} />
  {/if}

  <CredentialRotateActions {form} {projectId} {credentialId} {data} />
</form>
