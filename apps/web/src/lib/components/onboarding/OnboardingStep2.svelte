<script lang="ts">
  import { createCredential } from '$lib/api/credentials.js'
  import { ApiClientError } from '$lib/api/client.js'
  import type { OrgRole } from './onboarding-logic.js'
  import {
    canCreateCredential,
    onboardingCopy,
    parseTagsInput,
    validateCredentialForm,
  } from './onboarding-logic.js'

  let {
    orgRole,
    projectId,
    onCredentialCreated,
    onViewerContinue,
    headingId,
  }: {
    orgRole: OrgRole
    projectId: string
    onCredentialCreated: () => void
    onViewerContinue: () => void
    headingId: string
  } = $props()

  let name = $state('')
  let value = $state('')
  let description = $state('')
  let tags = $state('')
  let revealValue = $state(false)
  let submitting = $state(false)
  let credentialSaved = $state(false)
  let fieldErrors = $state<{ name?: string; value?: string }>({})
  let apiError = $state<string | null>(null)

  const canCreate = $derived(canCreateCredential(orgRole))

  async function submitCredential() {
    if (submitting || credentialSaved) return
    fieldErrors = validateCredentialForm({ name, value })
    if (fieldErrors.name || fieldErrors.value) return

    submitting = true
    apiError = null
    try {
      const tagList = parseTagsInput(tags)
      await createCredential(fetch, projectId, {
        name: name.trim(),
        value,
        description: description.trim() ? description.trim() : null,
        tags: tagList.length > 0 ? tagList : undefined,
      })
      credentialSaved = true
      value = ''
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 503) {
        apiError = onboardingCopy.vaultSealedMessage
      } else if (error instanceof ApiClientError && error.status === 422) {
        const details =
          error.details && typeof error.details === 'object'
            ? (error.details as Record<string, string[]>)
            : {}
        fieldErrors = {
          name: details.name?.[0],
          value: details.value?.[0],
        }
        apiError = error.message
      } else {
        apiError = error instanceof Error ? error.message : 'Could not save credential.'
      }
    } finally {
      submitting = false
    }
  }
</script>

{#if !canCreate}
  <section>
    <h2 id={headingId} class="text-2xl font-semibold text-slate-950" tabindex="-1">
      Add your first credential
    </h2>
    <p class="mt-4 text-slate-700">{onboardingCopy.viewerStep2Message}</p>
    <button
      class="mt-6 min-h-11 min-w-11 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white"
      type="button"
      onclick={onViewerContinue}
    >
      Continue to Dashboard
    </button>
  </section>
{:else}
  <section>
    <h2 id={headingId} class="text-2xl font-semibold text-slate-950" tabindex="-1">
      Add your first credential
    </h2>
    <form
      class="mt-4 space-y-4"
      onsubmit={(event) => {
        event.preventDefault()
        void submitCredential()
      }}
    >
      <div>
        <label class="block text-sm font-medium text-slate-800" for="credential-name">
          Name (public identifier)
        </label>
        <input
          id="credential-name"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          name="credential-name"
          autocomplete="off"
          bind:value={name}
          aria-invalid={fieldErrors.name ? 'true' : undefined}
        />
        {#if fieldErrors.name}
          <p class="mt-1 text-sm text-red-700" role="alert">{fieldErrors.name}</p>
        {/if}
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-800" for="credential-value">
          Value (stored securely)
        </label>
        <div class="mt-1 flex gap-2">
          <input
            id="credential-value"
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            type={revealValue ? 'text' : 'password'}
            name="credential-value"
            autocomplete="new-password"
            inputmode="text"
            aria-label="Credential value"
            bind:value
            aria-invalid={fieldErrors.value ? 'true' : undefined}
          />
          <button
            class="min-h-11 min-w-11 rounded-xl border border-slate-300 px-3 text-sm"
            type="button"
            aria-label={revealValue ? 'Hide value' : 'Show value'}
            onclick={() => {
              revealValue = !revealValue
            }}
          >
            {revealValue ? 'Hide' : 'Show'}
          </button>
        </div>
        {#if fieldErrors.value}
          <p class="mt-1 text-sm text-red-700" role="alert">{fieldErrors.value}</p>
        {/if}
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-800" for="credential-description">
          Description (optional)
        </label>
        <textarea
          id="credential-description"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"
          rows="2"
          bind:value={description}></textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-800" for="credential-tags">
          Tags (optional)
        </label>
        <input
          id="credential-tags"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          placeholder="production, api"
          bind:value={tags}
        />
      </div>

      {#if apiError}
        <p class="text-sm text-red-700" role="alert">{apiError}</p>
      {/if}
      {#if credentialSaved}
        <p class="text-sm text-emerald-700" role="status">✓ Credential saved securely</p>
      {/if}

      <div class="flex flex-wrap gap-3">
        <button
          class="min-h-11 min-w-11 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
          type="submit"
          disabled={submitting || credentialSaved}
        >
          {submitting ? 'Saving…' : 'Save Credential'}
        </button>
        <button
          class="min-h-11 min-w-11 rounded-xl border border-slate-300 px-4 py-3 text-sm font-medium disabled:opacity-50"
          type="button"
          disabled={!credentialSaved}
          onclick={onCredentialCreated}
        >
          Next
        </button>
      </div>
    </form>
  </section>
{/if}
