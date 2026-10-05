<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { invalidateAll } from '$app/navigation'
  import type { CredentialDetail } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import {
    addCredentialVersion,
    isFieldsValue,
    parseRevealedFields,
    revealCredentialValue,
  } from '$lib/api/credentials.js'
  import FieldSetEditor from '$lib/components/credentials/FieldSetEditor.svelte'
  import {
    mapCredentialSubmitError,
    validateFieldSet,
    type FieldDraft,
  } from '$lib/components/onboarding/onboarding-logic.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import {
    credentialKeyOf,
    archivedBannerFor,
    canRevealCredential,
    fieldMetaOf,
    isMultiFieldCredential,
    isCredentialArchived,
    type CredentialPointExtras,
  } from '$lib/credentials/credential-detail-helpers.js'
  import { m } from '$lib/paraglide/messages.js'
  import { resetOn } from '$lib/utils/reset-on.js'

  // Story 69.2: the Secret value section (reveal, per-field reveal, copy without reveal, add version,
  // field-set editor) as one replaceable region. Everything display-once (the revealed value, the
  // revealed fields, the editor's pre-filled values) lives in this component's local state: it is
  // never a prop of this component's point, never in `data`, never in a store or the URL.
  let {
    credential,
    projectId,
    credentialId,
    orgRole,
    project,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    orgRole: CredentialPointExtras['orgRole']
    project: CredentialPointExtras['project']
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 68.1 AC-3: SvelteKit reuses this component when navigating from credential A to B and
  // after invalidateAll(). Display-once secrets and in-progress forms are cleared when the record
  // changes (never sourced from `data`), and a request started on A that settles after A -> B is
  // dropped.
  const credentialKey = $derived(credentialKeyOf(projectId, credentialId))
  function isCurrentCredential(requestKey: string): boolean {
    return requestKey === credentialKey
  }

  const canReveal = $derived(canRevealCredential(orgRole, project))
  const isArchived = $derived(isCredentialArchived(credential))
  // Story 13.2: the current version's field metadata (keys/sensitivity); a legacy secret renders as
  // one unnamed masked field (AC-7).
  const fieldMeta = $derived(fieldMetaOf(credential))
  const isMultiField = $derived(isMultiFieldCredential(fieldMeta))
  // Story 13.3 AC-2: eagerly-decrypted non-sensitive field values from the detail response. Empty
  // for a legacy secret, a secret with no non-sensitive fields, or a degraded eager decrypt (that
  // field then falls back to the masked+Reveal treatment, same as a sensitive field).
  const visibleFieldValues = $derived<Record<string, string>>(credential.visibleFieldValues ?? {})

  let revealedValue = $derived(resetOn<string | null>(credentialKey, null))
  let revealVersion = $derived(resetOn<number | null>(credentialKey, null))
  let revealing = $state(false)
  let revealError = $state<string | null>(null)

  // Story 13.3 — per-field reveal/mask state for a genuinely multi-field secret. `revealedFields`
  // holds explicitly-revealed sensitive field values (and any non-sensitive field whose eager
  // decrypt degraded — AC-2 Failure Mode). "Hide" clears a key client-side only, no API call,
  // mirroring the existing whole-secret `revealedValue = null` convention.
  let revealedFields = $derived(resetOn<Record<string, string>>(credentialKey, {}))
  let revealingField = $state<string | null>(null)
  let fieldRevealError = $state<Record<string, string>>({})
  let revealAllLoading = $state(false)
  let revealAllError = $state<string | null>(null)

  // Story 13.3 AC-4 — reveal exactly one field. `GET .../value?field=<key>` is called; only that
  // field's value comes back and only that field is written to `revealedFields`.
  async function revealSingleField(key: string): Promise<void> {
    if (revealingField || !canReveal) return
    revealingField = key
    fieldRevealError = { ...fieldRevealError, [key]: '' }
    const requestKey = credentialKey
    try {
      const result = await revealCredentialValue(fetch, projectId, credentialId, {
        field: key,
      })
      if (!isCurrentCredential(requestKey)) return
      const value = isFieldsValue(result) ? (result.fields[0]?.value ?? '') : result.value
      revealedFields = { ...revealedFields, [key]: value }
    } catch (error) {
      if (!isCurrentCredential(requestKey)) return
      // AC-7/Subtask 3.5 — surface `unknown_field_key` inline near the affected row (e.g. a stale
      // field list after a concurrent rename) rather than as a generic top-level banner.
      if (error instanceof ApiClientError && error.code === 'unknown_field_key') {
        fieldRevealError = {
          ...fieldRevealError,
          [key]: 'This field no longer exists on this secret — refresh the page.',
        }
      } else {
        fieldRevealError = {
          ...fieldRevealError,
          [key]: error instanceof Error ? error.message : 'Could not reveal this field.',
        }
      }
    } finally {
      revealingField = null
    }
  }

  // Story 13.3 Subtask 3.4 — clears the field's in-memory revealed value only; no API call, same
  // convention as the existing whole-secret `revealedValue = null` "Hide".
  function hideField(key: string): void {
    const next = { ...revealedFields }
    delete next[key]
    revealedFields = next
  }

  // Story 13.3 AC-5/Subtask 3.2 — whole-secret reveal for a multi-field secret: every returned
  // field is rendered in its own row (never as one opaque blob, replacing the old raw-JSON dump).
  async function revealAllFields(): Promise<void> {
    if (revealAllLoading || !canReveal) return
    revealAllLoading = true
    revealAllError = null
    const requestKey = credentialKey
    try {
      const result = await revealCredentialValue(fetch, projectId, credentialId)
      if (!isCurrentCredential(requestKey)) return
      if (isFieldsValue(result)) {
        const updates: Record<string, string> = {}
        for (const field of result.fields) {
          if (field.sensitive) updates[field.key] = field.value
        }
        revealedFields = { ...revealedFields, ...updates }
      }
    } catch (error) {
      if (!isCurrentCredential(requestKey)) return
      revealAllError = error instanceof Error ? error.message : 'Could not reveal all fields.'
    } finally {
      revealAllLoading = false
    }
  }

  async function revealValue() {
    if (revealing || !canReveal) return
    revealing = true
    revealError = null
    const requestKey = credentialKey
    try {
      const result = await revealCredentialValue(fetch, projectId, credentialId)
      if (!isCurrentCredential(requestKey)) return
      // A single-field secret's reveal returns `{ value }`; narrow on the response union the same
      // way revealSingleField() does.
      revealedValue = isFieldsValue(result) ? (result.fields[0]?.value ?? '') : result.value
      revealVersion = result.versionNumber
    } catch (error) {
      if (!isCurrentCredential(requestKey)) return
      revealedValue = null
      revealVersion = null
      if (error instanceof ApiClientError && error.code === 'insufficient_project_role') {
        revealError =
          'Your role in this project does not permit revealing secret values — ask a project admin to change your role.'
      } else if (error instanceof ApiClientError && error.status === 403) {
        revealError = 'You do not have permission to reveal secret values.'
      } else {
        revealError = error instanceof Error ? error.message : 'Could not reveal value.'
      }
    } finally {
      revealing = false
    }
  }

  // AC-20/21: mirrors the existing `role="status"`/`aria-live="polite"` "✓ Credential saved
  // securely" pattern used elsewhere on this same page — a brief, auto-dismissing, announced
  // confirmation (or failure message) rather than a silent no-op or an unhandled rejection.
  type CopyStatus = { id: number; kind: 'success' | 'failure'; message: string }
  let copyStatuses = $state<CopyStatus[]>([])
  let nextCopyStatusId = 0
  const copyStatusTimeouts = new SvelteMap<number, ReturnType<typeof setTimeout>>()
  let pageMounted = $state(false)
  let copyRequestGeneration = 0
  let copyingValue = $state(false)
  let copyingFields = $state<Record<string, boolean>>({})

  function showCopyStatus(kind: 'success' | 'failure', message: string) {
    const id = nextCopyStatusId++
    copyStatuses = [...copyStatuses, { id, kind, message }]
    copyStatusTimeouts.set(
      id,
      setTimeout(() => {
        copyStatuses = copyStatuses.filter((status) => status.id !== id)
        copyStatusTimeouts.delete(id)
      }, 3000)
    )
  }

  async function copyWithoutReveal(field?: string): Promise<void> {
    if (!canReveal) return
    if (field ? copyingFields[field] === true : copyingValue) return

    if (field) {
      copyingFields = { ...copyingFields, [field]: true }
    } else {
      copyingValue = true
    }

    const requestGeneration = copyRequestGeneration
    const requestProjectId = projectId
    const requestCredentialId = credentialId
    try {
      // Keep this on the existing audited reveal boundary. The returned plaintext is deliberately
      // held only in this function long enough for the clipboard write; it never enters reveal
      // state or the rendered DOM.
      const result = field
        ? await revealCredentialValue(fetch, projectId, credentialId, { field })
        : await revealCredentialValue(fetch, projectId, credentialId)
      const value = isFieldsValue(result)
        ? (result.fields.find((entry) => entry.key === field)?.value ?? undefined)
        : result.value
      if (value === undefined) throw new Error('copy value missing')
      if (
        !pageMounted ||
        copyRequestGeneration !== requestGeneration ||
        projectId !== requestProjectId ||
        credentialId !== requestCredentialId
      ) {
        return
      }

      await navigator.clipboard.writeText(value)
      showCopyStatus(
        'success',
        field ? m.credential_copy_field_success({ field }) : m.credential_copy_legacy_success()
      )
    } catch {
      // Do not surface API or clipboard errors here: either may contain sensitive server detail.
      showCopyStatus(
        'failure',
        field ? m.credential_copy_field_failure({ field }) : m.credential_copy_legacy_failure()
      )
    } finally {
      if (field) {
        const next = { ...copyingFields }
        delete next[field]
        copyingFields = next
      } else {
        copyingValue = false
      }
    }
  }

  async function copyValue() {
    if (!revealedValue) return
    try {
      await navigator.clipboard.writeText(revealedValue)
      showCopyStatus('success', m.credential_copy_revealed_success())
    } catch {
      // Clipboard may be unavailable in some contexts (permissions denied, non-secure context).
      showCopyStatus('failure', m.credential_copy_revealed_failure())
    }
  }

  let newVersionValue = $state('')
  let addingVersion = $state(false)
  let addVersionError = $state<string | null>(null)
  let addVersionBanner = $state<string | null>(null)

  // AC-V1: version history is re-fetched via `invalidateAll` (reruns +page.server.ts's load,
  // which calls the real `listCredentialVersions`), not client-synthesized — the POST response
  // alone lacks fields (createdBy, purgedAt, abandonedAt) needed to render a correct history row.
  async function onAddVersion(): Promise<void> {
    if (addingVersion) return
    const value = newVersionValue.trim()
    if (!value) {
      addVersionError = 'Value is required'
      return
    }
    addingVersion = true
    addVersionError = null
    addVersionBanner = null
    try {
      await addCredentialVersion(fetch, projectId, credentialId, { value })
      newVersionValue = ''
      await invalidateAll()
    } catch (error) {
      const archivedBanner = archivedBannerFor(error)
      if (archivedBanner) {
        addVersionBanner = archivedBanner
      } else if (error instanceof ApiClientError && error.code === 'version_conflict') {
        addVersionError = 'Someone just added a version — refresh and try again.'
      } else {
        addVersionError = error instanceof Error ? error.message : 'Could not add version.'
      }
    } finally {
      addingVersion = false
    }
  }

  // Story 68.1 AC-3: the field-set editor is pre-filled with this credential's revealed values,
  // so it closes and clears when the record changes (never sourced from `data`).
  let editingFieldSet = $derived(resetOn(credentialKey, false))
  let editFields = $derived(resetOn<FieldDraft[]>(credentialKey, []))
  let fieldSetErrors = $state<Record<number, string>>({})
  let fieldSetFormError = $state<string | null>(null)
  let loadingFieldSet = $state(false)

  // AC-8 — editing a sensitive field is a blind overwrite: we reveal current values only to
  // pre-fill the form so unchanged fields round-trip (AC-4); there is no "reveal to edit" gate and
  // the user can overwrite any field directly.
  async function startEditFieldSet(): Promise<void> {
    if (loadingFieldSet) return
    loadingFieldSet = true
    fieldSetFormError = null
    const requestKey = credentialKey
    try {
      const revealed = await revealCredentialValue(fetch, projectId, credentialId)
      if (!isCurrentCredential(requestKey)) return
      editFields = parseRevealedFields(fieldMeta, revealed).map((f) => ({ ...f }))
      fieldSetErrors = {}
      editingFieldSet = true
    } catch (error) {
      if (!isCurrentCredential(requestKey)) return
      fieldSetFormError =
        error instanceof Error ? error.message : 'Could not load fields for editing.'
    } finally {
      loadingFieldSet = false
    }
  }

  function addEditField(): void {
    editFields = [...editFields, { key: '', value: '', sensitive: false }]
  }
  function removeEditField(index: number): void {
    editFields = editFields.filter((_, i) => i !== index)
    fieldSetErrors = {}
  }

  async function saveFieldSet(): Promise<void> {
    if (addingVersion) return
    const result = validateFieldSet(editFields)
    fieldSetErrors = result.fieldErrors
    if (!result.ok) {
      fieldSetFormError = result.formError ?? null
      return
    }
    addingVersion = true
    fieldSetFormError = null
    try {
      await addCredentialVersion(fetch, projectId, credentialId, {
        fields: editFields.map((f) => ({
          key: f.key.trim(),
          value: f.value,
          sensitive: f.sensitive,
        })),
      })
      editingFieldSet = false
      editFields = []
      await invalidateAll()
    } catch (error) {
      const archivedBanner = archivedBannerFor(error)
      if (archivedBanner) {
        fieldSetFormError = archivedBanner
      } else {
        const mapped = mapCredentialSubmitError(error)
        fieldSetFormError = mapped.errorMessage
        if (mapped.fieldKeyConflict) {
          const idx = editFields.findIndex(
            (f) => f.key.trim().toLowerCase() === mapped.fieldKeyConflict?.toLowerCase()
          )
          if (idx >= 0) fieldSetErrors = { ...fieldSetErrors, [idx]: mapped.errorMessage }
        }
      }
    } finally {
      addingVersion = false
    }
  }

  onMount(() => {
    pageMounted = true
  })

  onDestroy(() => {
    pageMounted = false
    copyRequestGeneration += 1
    revealedValue = null
    revealVersion = null
    revealedFields = {}
    for (const timeout of copyStatusTimeouts.values()) clearTimeout(timeout)
    copyStatusTimeouts.clear()
  })
</script>

<!-- @region credential.detail.value -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Secret value</h2>
  {#if isMultiField && !editingFieldSet}
    <!-- Story 13.3 AC-1/2/3 — per-field interactive rows: non-sensitive fields show their
         value inline (from the eager `visibleFieldValues`, no click); sensitive fields show a
         masked placeholder plus their own "Reveal" button. Visible to anyone who can view the
         secret at all (viewer role) — only the Reveal/Reveal-all buttons themselves are
         gated by canReveal (member+), same as the legacy path below. -->
    <ul class="mt-3 space-y-1" data-testid="field-list">
      {#each fieldMeta as meta (meta.key)}
        {@const eagerValue =
          !meta.sensitive && Object.hasOwn(visibleFieldValues, meta.key)
            ? visibleFieldValues[meta.key]
            : undefined}
        {@const revealedFieldValue = Object.hasOwn(revealedFields, meta.key)
          ? revealedFields[meta.key]
          : undefined}
        {@const fieldError = Object.hasOwn(fieldRevealError, meta.key)
          ? fieldRevealError[meta.key]
          : undefined}
        {@const isCopyingField = copyingFields[meta.key] === true}
        {@const copyHelpId = `credential-copy-help-${encodeURIComponent(meta.key)}`}
        <li
          class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"
          data-testid={`field-row-${meta.key}`}
        >
          <div class="min-w-0">
            <span class="font-medium text-slate-900">{meta.key}</span>
            {#if canReveal}
              <FormHelpText
                id={copyHelpId}
                text={m.credential_copy_field_help({ field: meta.key })}
              />
            {/if}
          </div>
          <div class="flex items-center gap-2">
            {#if eagerValue !== undefined}
              <span class="font-mono text-slate-700" data-testid={`field-value-${meta.key}`}
                >{eagerValue}</span
              >
            {:else if revealedFieldValue !== undefined}
              <span class="font-mono text-slate-700" data-testid={`field-value-${meta.key}`}
                >{revealedFieldValue}</span
              >
              {#if canReveal}
                <button
                  class="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium"
                  type="button"
                  onclick={() => hideField(meta.key)}
                >
                  Hide
                </button>
              {/if}
            {:else}
              <span class="text-slate-400" data-testid={`field-masked-${meta.key}`}>••••••••</span>
              {#if canReveal}
                <button
                  class="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium disabled:opacity-60"
                  type="button"
                  disabled={revealingField === meta.key}
                  onclick={() => void revealSingleField(meta.key)}
                >
                  {revealingField === meta.key ? 'Revealing…' : 'Reveal'}
                </button>
              {/if}
            {/if}
            {#if canReveal}
              <button
                class="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium disabled:opacity-60"
                type="button"
                aria-describedby={copyHelpId}
                disabled={isCopyingField}
                onclick={() => void copyWithoutReveal(meta.key)}
              >
                {isCopyingField
                  ? m.credential_copy_field_copying({ field: meta.key })
                  : m.credential_copy_field_label({ field: meta.key })}
              </button>
            {/if}
          </div>
        </li>
        {#if fieldError}
          <p class="text-sm text-red-700" role="alert">{fieldError}</p>
        {/if}
      {/each}
    </ul>
    {#if canReveal}
      <button
        class="mt-3 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
        type="button"
        disabled={revealAllLoading}
        onclick={() => void revealAllFields()}
      >
        {revealAllLoading ? 'Revealing all…' : 'Reveal all'}
      </button>
      {#if revealAllError}
        <p class="mt-2 text-sm text-red-700" role="alert">{revealAllError}</p>
      {/if}
    {/if}
  {/if}
  {#if canReveal}
    {#if !isMultiField}
      <!-- AC-6: legacy/single-default-field secret — byte-for-byte unchanged single reveal
           button + <pre> block. -->
      {#if revealedValue === null}
        <div class="mt-4 flex flex-wrap gap-3">
          <button
            class="rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            type="button"
            disabled={revealing}
            onclick={() => void revealValue()}
          >
            {revealing ? 'Revealing…' : 'Reveal value'}
          </button>
          <button
            class="rounded-xl border border-slate-300 px-4 py-3 text-sm font-medium disabled:opacity-60"
            type="button"
            aria-describedby="credential-copy-help"
            disabled={copyingValue}
            onclick={() => void copyWithoutReveal()}
          >
            {copyingValue ? m.credential_copy_legacy_copying() : m.credential_copy_legacy_label()}
          </button>
        </div>
        <FormHelpText id="credential-copy-help" text={m.credential_copy_legacy_help()} />
      {:else}
        <pre
          class="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{revealedValue}</pre>
        <div class="mt-3 flex gap-3">
          <button
            class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
            type="button"
            aria-describedby="credential-copy-revealed-help"
            onclick={() => void copyValue()}
          >
            {m.credential_copy_revealed_label()}
          </button>
          <button
            class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
            type="button"
            onclick={() => {
              revealedValue = null
              revealVersion = null
            }}
          >
            Hide
          </button>
        </div>
        {#if revealVersion !== null}
          <p class="mt-2 text-sm text-slate-600">Version {revealVersion}</p>
        {/if}
        <FormHelpText id="credential-copy-revealed-help" text={m.credential_copy_revealed_help()} />
      {/if}
      {#if revealError}
        <p class="mt-3 text-sm text-red-700" role="alert">{revealError}</p>
      {/if}
    {/if}

    {#each copyStatuses as status (status.id)}
      <p
        class={`mt-3 text-sm ${status.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
        role="status"
        aria-live="polite"
      >
        {status.message}
      </p>
    {/each}

    <div class="mt-6 border-t border-slate-200 pt-6">
      {#if isMultiField}
        <h3 class="font-semibold text-slate-950">Edit fields</h3>
        {#if !editingFieldSet}
          <button
            class="mt-3 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            type="button"
            disabled={loadingFieldSet}
            onclick={() => void startEditFieldSet()}
          >
            {loadingFieldSet ? 'Loading…' : 'Edit fields'}
          </button>
        {:else}
          <form
            method="post"
            class="mt-3 space-y-3"
            onsubmit={(event) => {
              event.preventDefault()
              void saveFieldSet()
            }}
          >
            <FieldSetEditor
              bind:fields={editFields}
              errors={fieldSetErrors}
              onAdd={addEditField}
              onRemove={removeEditField}
            />
            {#if fieldSetFormError}
              <p class="text-sm text-red-700" role="alert">{fieldSetFormError}</p>
            {/if}
            <div class="flex gap-2">
              <button
                class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                type="submit"
                disabled={addingVersion || isArchived}
              >
                {addingVersion ? 'Saving…' : 'Save fields'}
              </button>
              <button
                class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
                type="button"
                onclick={() => {
                  editingFieldSet = false
                  editFields = []
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        {/if}
      {:else}
        <h3 class="font-semibold text-slate-950">Add new version</h3>
        <form
          class="mt-3 space-y-3"
          onsubmit={(event) => {
            event.preventDefault()
            void onAddVersion()
          }}
        >
          <div class="space-y-1">
            <label class="block text-sm font-medium text-slate-800" for="new-version-value">
              New value
            </label>
            <textarea
              id="new-version-value"
              class="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm"
              bind:value={newVersionValue}
              aria-describedby="new-version-value-help"></textarea>
            <FormHelpText id="new-version-value-help" kind="secret" />
          </div>
          {#if addVersionError}
            <p class="text-sm text-red-700" role="alert">{addVersionError}</p>
          {/if}
          {#if addVersionBanner}
            <p class="text-sm text-red-700" role="alert">{addVersionBanner}</p>
          {/if}
          <button
            class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
            disabled={addingVersion || isArchived}
          >
            {addingVersion ? 'Adding…' : 'Add version'}
          </button>
        </form>
      {/if}
    </div>
  {:else}
    <p class="mt-3 text-sm text-slate-600">Revealing values requires Member access or higher.</p>
  {/if}<InjectionPoint name="credential.detail.value" props={pointProps} {data} />
</section>
