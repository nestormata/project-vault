<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { createCredential } from '$lib/api/credentials.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import {
    canCreateCredential,
    mapCredentialSubmitError,
    parseTagsInput,
    validateCredentialForm,
  } from '$lib/components/onboarding/onboarding-logic.js'

  let { data } = $props()

  let name = $state('')
  let value = $state('')
  let description = $state('')
  let tags = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ name?: string; value?: string }>({})

  const canCreate = $derived(canCreateCredential(data.orgRole))

  async function submitForm() {
    if (submitting || !canCreate) return
    fieldErrors = validateCredentialForm({ name, value })
    if (fieldErrors.name || fieldErrors.value) return

    submitting = true
    errorMessage = null
    try {
      const tagList = parseTagsInput(tags)
      const created = await createCredential(fetch, data.projectId, {
        name: name.trim(),
        value,
        description: description.trim() ? description.trim() : null,
        tags: tagList.length > 0 ? tagList : undefined,
      })
      value = ''
      await goto(resolve(`/projects/${data.projectId}/credentials/${created.id}`))
    } catch (error) {
      value = ''
      const mapped = mapCredentialSubmitError(error)
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
    }
  }
</script>

<svelte:head>
  <title>New credential | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New credential</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Add credential</h1>
  </div>

  {#if !canCreate}
    <AccessNotice
      title="Create not available"
      message="Credential creation requires Member access or higher. Ask your administrator to upgrade your role."
      backHref={`/projects/${data.projectId}/credentials`}
      backLabel="Back to credentials"
    />
  {:else}
    <form
      class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      onsubmit={(event) => {
        event.preventDefault()
        void submitForm()
      }}
    >
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="credential-name">Name</label>
        <input
          id="credential-name"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          bind:value={name}
          autocomplete="off"
          required
        />
        {#if fieldErrors.name}
          <p class="text-sm text-red-700">{fieldErrors.name}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="credential-value">Value</label>
        <input
          id="credential-value"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 font-mono"
          type="password"
          bind:value
          autocomplete="new-password"
          required
        />
        {#if fieldErrors.value}
          <p class="text-sm text-red-700">{fieldErrors.value}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="credential-description"
          >Description</label
        >
        <textarea
          id="credential-description"
          class="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-3"
          bind:value={description}></textarea>
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="credential-tags">Tags</label>
        <input
          id="credential-tags"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          placeholder="production, api"
          bind:value={tags}
        />
      </div>

      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}

      <FormSubmitRow
        submitLabel="Create credential"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/credentials`}
        {submitting}
      />
    </form>
  {/if}
</section>
