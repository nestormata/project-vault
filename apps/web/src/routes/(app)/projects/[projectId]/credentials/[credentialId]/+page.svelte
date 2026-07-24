<script lang="ts">
  import { onDestroy } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import type { FieldMeta, SystemType } from '@project-vault/shared'
  import { DEFAULT_FIELD_KEY } from '@project-vault/shared'
  import {
    addCredentialDependency,
    addCredentialVersion,
    archiveCredentialDependency,
    parseRevealedFields,
    revealCredentialValue,
    updateCredentialLifecycle,
  } from '$lib/api/credentials.js'
  import { ApiClientError } from '$lib/api/client.js'
  import FieldSetEditor from '$lib/components/credentials/FieldSetEditor.svelte'
  import {
    canCreateCredential,
    mapCredentialSubmitError,
    onboardingCopy,
    validateFieldSet,
    type FieldDraft,
  } from '$lib/components/onboarding/onboarding-logic.js'
  import {
    lifecycleDateInputToIso,
    toLifecycleDateInputValue,
  } from '$lib/credentials/lifecycle-form.js'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import { canManageRotations } from '$lib/components/rotations/rotation-permissions.js'
  import {
    formatDateTime,
    rotationCopy,
    rotationStatusBadgeClass,
  } from '$lib/components/rotations/rotation-copy.js'

  let { data } = $props()

  // AC-L4/AC-D5/AC-V4: the UI has no way to know ahead of time that the parent project is
  // archived, so every mutation on this page reacts to the real 410 the same way, with the same
  // copy, rather than each section growing its own bespoke banner text.
  const ARCHIVED_PROJECT_BANNER = 'This project is archived — unarchive it to make changes.'

  let revealedValue = $state<string | null>(null)
  let revealVersion = $state<number | null>(null)
  let revealing = $state(false)
  let revealError = $state<string | null>(null)

  // AC-L1: local override applied after a successful lifecycle save so the read-only summary
  // grid above updates without a full page reload; null means "show data.credential's value".
  let lifecycleOverride = $state<{
    expiresAt: string | null
    rotationSchedule: string | null
  } | null>(null)
  let lifecycleExpiresAt = $state(toLifecycleDateInputValue(data.credential?.expiresAt ?? null))
  let lifecycleRotationSchedule = $state(data.credential?.rotationSchedule ?? '')
  // AC-L1: pre-fill from the credential detail's real cacheable flag (defaults only when the
  // detail is missing — never hardcode `true`, which would silently re-enable caching on save).
  let lifecycleCacheable = $state(data.credential?.cacheable ?? true)
  let lifecycleSubmitting = $state(false)
  let lifecycleFieldError = $state<string | null>(null)
  let lifecycleBanner = $state<string | null>(null)

  const canReveal = $derived(canCreateCredential(data.orgRole))
  const canManageRotation = $derived(canManageRotations(data.orgRole))
  const displayExpiresAt = $derived(
    lifecycleOverride ? lifecycleOverride.expiresAt : (data.credential?.expiresAt ?? null)
  )

  async function onSaveLifecycle(): Promise<void> {
    if (lifecycleSubmitting || !data.credential) return
    lifecycleSubmitting = true
    lifecycleFieldError = null
    lifecycleBanner = null
    try {
      const result = await updateCredentialLifecycle(fetch, data.projectId, data.credentialId, {
        expiresAt: lifecycleDateInputToIso(lifecycleExpiresAt),
        rotationSchedule:
          lifecycleRotationSchedule.trim() === '' ? null : lifecycleRotationSchedule,
        cacheable: lifecycleCacheable,
      })
      lifecycleOverride = { expiresAt: result.expiresAt, rotationSchedule: result.rotationSchedule }
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'invalid_cron') {
        lifecycleFieldError = error.message
      } else if (error instanceof ApiClientError && error.status === 410) {
        lifecycleBanner = ARCHIVED_PROJECT_BANNER
      } else {
        lifecycleFieldError =
          error instanceof Error ? error.message : 'Could not update lifecycle fields.'
      }
    } finally {
      lifecycleSubmitting = false
    }
  }

  // AC-D1: local list so a successful add/archive updates the UI immediately without a reload;
  // seeded once from the loader's data, same "state_referenced_locally" convention used elsewhere
  // on this page (see lifecycleExpiresAt above) and on the projects list page's tag inputs.
  let dependencyItems = $state(data.dependencies.items)
  let depSystemName = $state('')
  let depSystemType = $state<SystemType>('other')
  let depNotes = $state('')
  let depSubmitting = $state(false)
  let depError = $state<string | null>(null)
  let depBanner = $state<string | null>(null)
  let archivingDependencyId = $state<string | null>(null)

  async function onAddDependency(): Promise<void> {
    if (depSubmitting || !data.credential) return
    const systemName = depSystemName.trim()
    if (!systemName) return
    depSubmitting = true
    depError = null
    depBanner = null
    try {
      const notes = depNotes.trim()
      const created = await addCredentialDependency(fetch, data.projectId, data.credentialId, {
        systemName,
        systemType: depSystemType,
        ...(notes ? { notes } : {}),
      })
      dependencyItems = [...dependencyItems, created]
      depSystemName = ''
      depSystemType = 'other'
      depNotes = ''
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        depBanner = ARCHIVED_PROJECT_BANNER
      } else if (error instanceof ApiClientError && error.code === 'too_many_dependencies') {
        depError = error.message
      } else {
        depError = error instanceof Error ? error.message : 'Could not add dependent system.'
      }
    } finally {
      depSubmitting = false
    }
  }

  async function onArchiveDependency(dependencyId: string): Promise<void> {
    if (archivingDependencyId || !data.credential) return
    archivingDependencyId = dependencyId
    depBanner = null
    try {
      await archiveCredentialDependency(fetch, data.projectId, data.credentialId, dependencyId)
      dependencyItems = dependencyItems.filter((item) => item.id !== dependencyId)
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        depBanner = ARCHIVED_PROJECT_BANNER
      } else {
        depError = error instanceof Error ? error.message : 'Could not archive dependent system.'
      }
    } finally {
      archivingDependencyId = null
    }
  }

  onDestroy(() => {
    revealedValue = null
    revealVersion = null
    if (copyStatusTimeout) clearTimeout(copyStatusTimeout)
  })

  async function revealValue() {
    if (revealing || !canReveal || !data.credential) return
    revealing = true
    revealError = null
    try {
      const result = await revealCredentialValue(fetch, data.projectId, data.credentialId)
      revealedValue = result.value
      revealVersion = result.versionNumber
    } catch (error) {
      revealedValue = null
      revealVersion = null
      if (error instanceof ApiClientError && error.code === 'insufficient_project_role') {
        revealError =
          'Your role in this project does not permit revealing credential values — ask a project admin to change your role.'
      } else if (error instanceof ApiClientError && error.status === 403) {
        revealError = 'You do not have permission to reveal credential values.'
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
  let copyStatus = $state<{ kind: 'success' | 'failure'; message: string } | null>(null)
  let copyStatusTimeout: ReturnType<typeof setTimeout> | null = null

  function showCopyStatus(kind: 'success' | 'failure', message: string) {
    if (copyStatusTimeout) clearTimeout(copyStatusTimeout)
    copyStatus = { kind, message }
    copyStatusTimeout = setTimeout(() => {
      copyStatus = null
      copyStatusTimeout = null
    }, 3000)
  }

  async function copyValue() {
    if (!revealedValue) return
    try {
      await navigator.clipboard.writeText(revealedValue)
      showCopyStatus('success', 'Copied to clipboard')
    } catch {
      // Clipboard may be unavailable in some contexts (permissions denied, non-secure context).
      showCopyStatus('failure', "Couldn't copy — copy manually")
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
    if (addingVersion || !data.credential) return
    const value = newVersionValue.trim()
    if (!value) {
      addVersionError = 'Value is required'
      return
    }
    addingVersion = true
    addVersionError = null
    addVersionBanner = null
    try {
      await addCredentialVersion(fetch, data.projectId, data.credentialId, { value })
      newVersionValue = ''
      await invalidateAll()
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        addVersionBanner = ARCHIVED_PROJECT_BANNER
      } else if (error instanceof ApiClientError && error.code === 'version_conflict') {
        addVersionError = 'Someone just added a version — refresh and try again.'
      } else {
        addVersionError = error instanceof Error ? error.message : 'Could not add version.'
      }
    } finally {
      addingVersion = false
    }
  }

  // Story 13.2 — the current version's field metadata (keys/sensitivity). A legacy schema_version=1
  // secret (or any single-default-field secret) renders as one unnamed masked field, identical to
  // its pre-Phase-2 appearance (AC-7); anything else renders the multi-field editor.
  const fieldMeta = $derived<FieldMeta[]>(
    data.credential?.fields ?? [{ key: DEFAULT_FIELD_KEY, sensitive: true }]
  )
  const isMultiField = $derived(
    fieldMeta.length > 1 || (fieldMeta[0]?.key ?? DEFAULT_FIELD_KEY) !== DEFAULT_FIELD_KEY
  )

  let editingFieldSet = $state(false)
  let editFields = $state<FieldDraft[]>([])
  let fieldSetErrors = $state<Record<number, string>>({})
  let fieldSetFormError = $state<string | null>(null)
  let loadingFieldSet = $state(false)

  // AC-8 — editing a sensitive field is a blind overwrite: we reveal current values only to
  // pre-fill the form so unchanged fields round-trip (AC-4); there is no "reveal to edit" gate and
  // the user can overwrite any field directly.
  async function startEditFieldSet(): Promise<void> {
    if (loadingFieldSet || !data.credential) return
    loadingFieldSet = true
    fieldSetFormError = null
    try {
      const revealed = await revealCredentialValue(fetch, data.projectId, data.credentialId)
      editFields = parseRevealedFields(fieldMeta, revealed.value).map((f) => ({ ...f }))
      fieldSetErrors = {}
      editingFieldSet = true
    } catch (error) {
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
    if (addingVersion || !data.credential) return
    const result = validateFieldSet(editFields)
    fieldSetErrors = result.fieldErrors
    if (!result.ok) {
      fieldSetFormError = result.formError ?? null
      return
    }
    addingVersion = true
    fieldSetFormError = null
    try {
      await addCredentialVersion(fetch, data.projectId, data.credentialId, {
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
      if (error instanceof ApiClientError && error.status === 410) {
        fieldSetFormError = ARCHIVED_PROJECT_BANNER
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
</script>

<svelte:head>
  <title>{data.credential?.name ?? 'Credential'} | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  {#if data.vaultSealed}
    <PageAlertBanner title="Vault sealed" message={onboardingCopy.vaultSealedMessage} />
  {:else if data.notFound || !data.credential}
    <PageAlertBanner
      title="Credential not found"
      message="This credential does not exist or you do not have access."
      backHref={`/projects/${data.projectId}/credentials`}
      backLabel="Back to credentials"
    />
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Credential</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.credential.name}</h1>
      {#if data.credential.description}
        <p class="mt-2 text-slate-600">{data.credential.description}</p>
      {/if}
      <dl class="mt-5 grid gap-3 sm:grid-cols-2">
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Tags</dt>
          <dd class="font-medium text-slate-950">
            {data.credential.tags.length > 0 ? data.credential.tags.join(', ') : '—'}
          </dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Expires</dt>
          <dd class="font-medium text-slate-950">{formatDateTime(displayExpiresAt)}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Current version</dt>
          <dd class="font-medium text-slate-950">{data.credential.currentVersionNumber}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Updated</dt>
          <dd class="font-medium text-slate-950">{formatDateTime(data.credential.updatedAt)}</dd>
        </div>
      </dl>

      {#if canReveal}
        <div class="mt-6 border-t border-slate-200 pt-6">
          <h2 class="text-lg font-semibold text-slate-950">Lifecycle</h2>
          <form
            class="mt-4 space-y-4"
            onsubmit={(event) => {
              event.preventDefault()
              void onSaveLifecycle()
            }}
          >
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="lifecycle-expires-at">
                Expiry date
              </label>
              <input
                id="lifecycle-expires-at"
                class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
                type="date"
                bind:value={lifecycleExpiresAt}
              />
            </div>
            <div class="space-y-1">
              <label
                class="block text-sm font-medium text-slate-800"
                for="lifecycle-rotation-schedule"
              >
                Rotation schedule (cron)
              </label>
              <input
                id="lifecycle-rotation-schedule"
                class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
                type="text"
                placeholder="0 0 1 * *"
                bind:value={lifecycleRotationSchedule}
              />
              {#if lifecycleFieldError}
                <p class="text-sm text-red-700" role="alert">{lifecycleFieldError}</p>
              {/if}
            </div>
            <label class="flex items-center gap-2 text-sm text-slate-800">
              <input type="checkbox" bind:checked={lifecycleCacheable} />
              Cacheable by offline agents
            </label>
            {#if lifecycleBanner}
              <p class="text-sm text-red-700" role="alert">{lifecycleBanner}</p>
            {/if}
            <button
              class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={lifecycleSubmitting}
            >
              {lifecycleSubmitting ? 'Saving…' : 'Save lifecycle'}
            </button>
          </form>
        </div>
      {/if}
    </div>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Secret value</h2>
      {#if isMultiField && !editingFieldSet}
        <ul class="mt-3 space-y-1" data-testid="field-list">
          {#each fieldMeta as meta (meta.key)}
            <li class="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span class="font-medium text-slate-900">{meta.key}</span>
              <span class="text-slate-500">{meta.sensitive ? 'Masked' : 'Text'}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if canReveal}
        {#if revealedValue === null}
          <button
            class="mt-4 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            type="button"
            disabled={revealing}
            onclick={() => void revealValue()}
          >
            {revealing ? 'Revealing…' : 'Reveal value'}
          </button>
        {:else}
          <pre
            class="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{revealedValue}</pre>
          <div class="mt-3 flex gap-3">
            <button
              class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
              type="button"
              onclick={() => void copyValue()}
            >
              Copy
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
          {#if copyStatus}
            <p
              class={`mt-2 text-sm ${copyStatus.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
              role="status"
            >
              {copyStatus.message}
            </p>
          {/if}
          {#if revealVersion !== null}
            <p class="mt-2 text-sm text-slate-600">Version {revealVersion}</p>
          {/if}
        {/if}
        {#if revealError}
          <p class="mt-3 text-sm text-red-700" role="alert">{revealError}</p>
        {/if}

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
                    disabled={addingVersion}
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
                  bind:value={newVersionValue}></textarea>
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
                disabled={addingVersion}
              >
                {addingVersion ? 'Adding…' : 'Add version'}
              </button>
            </form>
          {/if}
        </div>
      {:else}
        <p class="mt-3 text-sm text-slate-600">
          Revealing values requires Member access or higher.
        </p>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Version history</h2>
      {#if data.versions.length === 0}
        <p class="mt-3 text-sm text-slate-600">No version history available.</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each data.versions as version (version.versionNumber)}
            <li
              class="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <span class="font-medium">Version {version.versionNumber}</span>
              <span class="text-slate-600">{formatDateTime(version.createdAt)}</span>
              {#if version.isCurrent}
                <span
                  class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800"
                >
                  Current
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Dependent systems</h2>
      {#if dependencyItems.length === 0}
        <p class="mt-3 text-sm text-slate-600">No dependent systems recorded.</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each dependencyItems as dependency (dependency.id)}
            <li
              class="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <span class="font-medium">{dependency.systemName} ({dependency.systemType})</span>
              {#if canReveal}
                <button
                  class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                  type="button"
                  disabled={archivingDependencyId === dependency.id}
                  onclick={() => void onArchiveDependency(dependency.id)}
                >
                  {archivingDependencyId === dependency.id ? 'Archiving…' : 'Archive'}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if canReveal}
        <div class="mt-6 border-t border-slate-200 pt-6">
          <h3 class="font-semibold text-slate-950">Add dependent system</h3>
          <form
            class="mt-3 space-y-3"
            onsubmit={(event) => {
              event.preventDefault()
              void onAddDependency()
            }}
          >
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="dependency-system-name">
                System name
              </label>
              <input
                id="dependency-system-name"
                class="w-full rounded-xl border border-slate-300 px-3 py-2"
                type="text"
                required
                bind:value={depSystemName}
              />
            </div>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="dependency-system-type">
                System type
              </label>
              <select
                id="dependency-system-type"
                class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
                bind:value={depSystemType}
              >
                <option value="service">Service</option>
                <option value="ci_pipeline">CI pipeline</option>
                <option value="database">Database</option>
                <option value="third_party">Third party</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="dependency-notes">
                Notes
              </label>
              <textarea
                id="dependency-notes"
                class="w-full rounded-xl border border-slate-300 px-3 py-2"
                bind:value={depNotes}></textarea>
            </div>
            {#if depError}
              <p class="text-sm text-red-700" role="alert">{depError}</p>
            {/if}
            {#if depBanner}
              <p class="text-sm text-red-700" role="alert">{depBanner}</p>
            {/if}
            <button
              class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={depSubmitting}
            >
              {depSubmitting ? 'Adding…' : 'Add dependent system'}
            </button>
          </form>
        </div>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Rotation</h2>

      {#if data.activeRotationId}
        <a
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
          href={resolve(
            `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${data.activeRotationId}`
          )}
        >
          View active rotation
        </a>
      {:else if canManageRotation}
        <a
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
          href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}/rotate`)}
        >
          Start rotation
        </a>
      {:else}
        <p class="mt-3 text-sm text-slate-600">{rotationCopy.startRotationRequiresAdmin}</p>
      {/if}

      <h3 class="mt-6 font-semibold text-slate-950">History</h3>
      {#if data.rotations.length === 0}
        <p class="mt-3 text-sm text-slate-600">{rotationCopy.noRotationsYet}</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each data.rotations as rotation (rotation.id)}
            <li
              class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <a
                class="font-medium text-slate-950 underline"
                href={resolve(
                  `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${rotation.id}`
                )}
              >
                initiated {formatDateTime(rotation.initiatedAt)}
              </a>
              <span class={rotationStatusBadgeClass(rotation.status)}>{rotation.status}</span>
              <span class="text-slate-600">completed {formatDateTime(rotation.completedAt)}</span>
              <span class="text-slate-600">
                {rotation.confirmedCount}/{rotation.itemCount} confirmed
              </span>
            </li>
          {/each}
        </ul>
        {#if data.rotationsHasMore}
          <a
            class="mt-3 inline-block text-sm font-medium text-slate-700 underline"
            href={resolve(
              `/projects/${data.projectId}/credentials/${data.credentialId}?page=${data.rotationsPage + 1}`
            )}
          >
            Show more
          </a>
        {/if}
      {/if}
    </section>

    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/credentials`)}
    >
      Back to credentials
    </a>
  {/if}
</section>
