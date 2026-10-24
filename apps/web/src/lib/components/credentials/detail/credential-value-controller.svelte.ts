import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invalidateAll } from '$app/navigation'
import { ApiClientError } from '$lib/api/client.js'
import {
  addCredentialVersion,
  isFieldsValue,
  parseRevealedFields,
  revealCredentialValue,
} from '$lib/api/credentials.js'
import {
  mapCredentialSubmitError,
  validateFieldSet,
  type FieldDraft,
} from '$lib/components/onboarding/onboarding-logic.js'
import {
  archivedBannerFor,
  isMultiFieldCredential,
} from '$lib/credentials/credential-detail-helpers.js'
import { m } from '$lib/paraglide/messages.js'
import { resetOn } from '$lib/utils/reset-on.js'
import {
  CredentialSectionController,
  type CredentialSectionRegionProps,
  type CredentialSectionSource,
} from './credential-section-controller.svelte.js'

export type CredentialValueSource = CredentialSectionSource

export type CredentialValueRegionProps = CredentialSectionRegionProps<CredentialValueController>

export type CopyStatus = { id: number; kind: 'success' | 'failure'; message: string }

const COPY_STATUS_MS = 3000

// Story 69-14: the one owner of the Secret value section's state (reveal, per-field reveal, copy
// without reveal, add version, field-set editor). The section creates it and hands it to its
// sub-regions as a prop. Everything display-once (the revealed value, the revealed fields, the
// editor's pre-filled values) lives here: it is never a prop of a point, never in `data`, never in a
// store or the URL.
export class CredentialValueController extends CredentialSectionController<CredentialValueSource> {
  // Story 68.1 AC-3: SvelteKit reuses the section when navigating from credential A to B and after
  // invalidateAll(). Display-once secrets and in-progress forms are cleared when the record
  // changes (never sourced from `data`), and a request started on A that settles after A -> B is
  // dropped.
  isMultiField = $derived(isMultiFieldCredential(this.fieldMeta))
  // Story 13.3 AC-2: eagerly-decrypted non-sensitive field values from the detail response. Empty
  // for a legacy secret, a secret with no non-sensitive fields, or a degraded eager decrypt (that
  // field then falls back to the masked+Reveal treatment, same as a sensitive field).
  visibleFieldValues = $derived<Record<string, string>>(this.credential.visibleFieldValues ?? {})

  #isCurrentCredential(requestKey: string): boolean {
    return requestKey === this.credentialKey
  }

  revealedValue = $derived(resetOn<string | null>(this.credentialKey, null))
  revealVersion = $derived(resetOn<number | null>(this.credentialKey, null))
  revealing = $state(false)
  revealError = $state<string | null>(null)

  // Story 13.3 — per-field reveal/mask state for a genuinely multi-field secret. `revealedFields`
  // holds explicitly-revealed sensitive field values (and any non-sensitive field whose eager
  // decrypt degraded — AC-2 Failure Mode). "Hide" clears a key client-side only, no API call,
  // mirroring the existing whole-secret `revealedValue = null` convention.
  revealedFields = $derived(resetOn<Record<string, string>>(this.credentialKey, {}))
  revealingField = $state<string | null>(null)
  fieldRevealError = $state<Record<string, string>>({})
  revealAllLoading = $state(false)
  revealAllError = $state<string | null>(null)

  // Story 13.3 AC-4 — reveal exactly one field. `GET .../value?field=<key>` is called; only that
  // field's value comes back and only that field is written to `revealedFields`.
  async revealSingleField(key: string): Promise<void> {
    if (this.revealingField || !this.canReveal) return
    this.revealingField = key
    this.fieldRevealError = { ...this.fieldRevealError, [key]: '' }
    const requestKey = this.credentialKey
    try {
      const result = await revealCredentialValue(fetch, this.projectId, this.credentialId, {
        field: key,
      })
      if (!this.#isCurrentCredential(requestKey)) return
      const value = isFieldsValue(result) ? (result.fields[0]?.value ?? '') : result.value
      this.revealedFields = { ...this.revealedFields, [key]: value }
    } catch (error) {
      if (!this.#isCurrentCredential(requestKey)) return
      // AC-7/Subtask 3.5 — surface `unknown_field_key` inline near the affected row (e.g. a stale
      // field list after a concurrent rename) rather than as a generic top-level banner.
      this.fieldRevealError = {
        ...this.fieldRevealError,
        [key]: fieldRevealFailureMessage(error),
      }
    } finally {
      this.revealingField = null
    }
  }

  // Story 13.3 Subtask 3.4 — clears the field's in-memory revealed value only; no API call, same
  // convention as the existing whole-secret `revealedValue = null` "Hide".
  hideField(key: string): void {
    this.revealedFields = omitKey(this.revealedFields, key)
  }

  hideValue(): void {
    this.revealedValue = null
    this.revealVersion = null
  }

  // Story 13.3 AC-5/Subtask 3.2 — whole-secret reveal for a multi-field secret: every returned
  // field is rendered in its own row (never as one opaque blob, replacing the old raw-JSON dump).
  async revealAllFields(): Promise<void> {
    if (this.revealAllLoading || !this.canReveal) return
    this.revealAllLoading = true
    this.revealAllError = null
    const requestKey = this.credentialKey
    try {
      const result = await revealCredentialValue(fetch, this.projectId, this.credentialId)
      if (!this.#isCurrentCredential(requestKey)) return
      if (isFieldsValue(result)) {
        const updates: Record<string, string> = {}
        for (const field of result.fields) {
          if (field.sensitive) updates[field.key] = field.value
        }
        this.revealedFields = { ...this.revealedFields, ...updates }
      }
    } catch (error) {
      if (!this.#isCurrentCredential(requestKey)) return
      this.revealAllError = error instanceof Error ? error.message : 'Could not reveal all fields.'
    } finally {
      this.revealAllLoading = false
    }
  }

  async revealValue(): Promise<void> {
    if (this.revealing || !this.canReveal) return
    this.revealing = true
    this.revealError = null
    const requestKey = this.credentialKey
    try {
      const result = await revealCredentialValue(fetch, this.projectId, this.credentialId)
      if (!this.#isCurrentCredential(requestKey)) return
      // A single-field secret's reveal returns `{ value }`; narrow on the response union the same
      // way revealSingleField() does.
      this.revealedValue = isFieldsValue(result) ? (result.fields[0]?.value ?? '') : result.value
      this.revealVersion = result.versionNumber
    } catch (error) {
      if (!this.#isCurrentCredential(requestKey)) return
      this.revealedValue = null
      this.revealVersion = null
      this.revealError = revealFailureMessage(error)
    } finally {
      this.revealing = false
    }
  }

  // AC-20/21: mirrors the existing `role="status"`/`aria-live="polite"` "✓ Credential saved
  // securely" pattern used elsewhere on this same page — a brief, auto-dismissing, announced
  // confirmation (or failure message) rather than a silent no-op or an unhandled rejection.
  copyStatuses = $state<CopyStatus[]>([])
  #nextCopyStatusId = 0
  readonly #copyStatusTimeouts = new SvelteMap<number, ReturnType<typeof setTimeout>>()
  #mounted = $state(false)
  #copyRequestGeneration = 0
  copyingValue = $state(false)
  readonly copyingFields = new SvelteSet<string>()

  #showCopyStatus(kind: 'success' | 'failure', message: string): void {
    const id = this.#nextCopyStatusId++
    this.copyStatuses = [...this.copyStatuses, { id, kind, message }]
    this.#copyStatusTimeouts.set(
      id,
      setTimeout(() => {
        this.copyStatuses = this.copyStatuses.filter((status) => status.id !== id)
        this.#copyStatusTimeouts.delete(id)
      }, COPY_STATUS_MS)
    )
  }

  #isCopyInFlight(field: string | undefined): boolean {
    return field ? this.copyingFields.has(field) : this.copyingValue
  }

  #setCopying(field: string | undefined, busy: boolean): void {
    if (!field) {
      this.copyingValue = busy
    } else if (busy) {
      this.copyingFields.add(field)
    } else {
      this.copyingFields.delete(field)
    }
  }

  #isStaleCopy(generation: number, requestProjectId: string, requestCredentialId: string): boolean {
    return (
      !this.#mounted ||
      this.#copyRequestGeneration !== generation ||
      this.projectId !== requestProjectId ||
      this.credentialId !== requestCredentialId
    )
  }

  async copyWithoutReveal(field?: string): Promise<void> {
    if (!this.canReveal) return
    if (this.#isCopyInFlight(field)) return
    this.#setCopying(field, true)

    const requestGeneration = this.#copyRequestGeneration
    const requestProjectId = this.projectId
    const requestCredentialId = this.credentialId
    try {
      // Keep this on the existing audited reveal boundary. The returned plaintext is deliberately
      // held only in this function long enough for the clipboard write; it never enters reveal
      // state or the rendered DOM.
      const result = field
        ? await revealCredentialValue(fetch, this.projectId, this.credentialId, { field })
        : await revealCredentialValue(fetch, this.projectId, this.credentialId)
      const value = copyableValue(result, field)
      if (this.#isStaleCopy(requestGeneration, requestProjectId, requestCredentialId)) return

      await navigator.clipboard.writeText(value)
      this.#showCopyStatus('success', copySuccessMessage(field))
    } catch {
      // Do not surface API or clipboard errors here: either may contain sensitive server detail.
      this.#showCopyStatus('failure', copyFailureMessage(field))
    } finally {
      this.#setCopying(field, false)
    }
  }

  async copyValue(): Promise<void> {
    if (!this.revealedValue) return
    try {
      await navigator.clipboard.writeText(this.revealedValue)
      this.#showCopyStatus('success', m.credential_copy_revealed_success())
    } catch {
      // Clipboard may be unavailable in some contexts (permissions denied, non-secure context).
      this.#showCopyStatus('failure', m.credential_copy_revealed_failure())
    }
  }

  newVersionValue = $state('')
  addingVersion = $state(false)
  addVersionError = $state<string | null>(null)
  addVersionBanner = $state<string | null>(null)

  // AC-V1: version history is re-fetched via `invalidateAll` (reruns +page.server.ts's load,
  // which calls the real `listCredentialVersions`), not client-synthesized — the POST response
  // alone lacks fields (createdBy, purgedAt, abandonedAt) needed to render a correct history row.
  async addVersion(): Promise<void> {
    if (this.addingVersion) return
    const value = this.newVersionValue.trim()
    if (!value) {
      this.addVersionError = 'Value is required'
      return
    }
    this.addingVersion = true
    this.addVersionError = null
    this.addVersionBanner = null
    try {
      await addCredentialVersion(fetch, this.projectId, this.credentialId, { value })
      this.newVersionValue = ''
      await invalidateAll()
    } catch (error) {
      const archivedBanner = archivedBannerFor(error)
      if (archivedBanner) {
        this.addVersionBanner = archivedBanner
      } else if (error instanceof ApiClientError && error.code === 'version_conflict') {
        this.addVersionError = 'Someone just added a version — refresh and try again.'
      } else {
        this.addVersionError = error instanceof Error ? error.message : 'Could not add version.'
      }
    } finally {
      this.addingVersion = false
    }
  }

  // Story 68.1 AC-3: the field-set editor is pre-filled with this credential's revealed values,
  // so it closes and clears when the record changes (never sourced from `data`).
  editingFieldSet = $derived(resetOn(this.credentialKey, false))
  editFields = $derived(resetOn<FieldDraft[]>(this.credentialKey, []))
  fieldSetErrors = $state<Record<number, string>>({})
  fieldSetFormError = $state<string | null>(null)
  loadingFieldSet = $state(false)

  // AC-8 — editing a sensitive field is a blind overwrite: we reveal current values only to
  // pre-fill the form so unchanged fields round-trip (AC-4); there is no "reveal to edit" gate and
  // the user can overwrite any field directly.
  async startEditFieldSet(): Promise<void> {
    if (this.loadingFieldSet) return
    this.loadingFieldSet = true
    this.fieldSetFormError = null
    const requestKey = this.credentialKey
    try {
      const revealed = await revealCredentialValue(fetch, this.projectId, this.credentialId)
      if (!this.#isCurrentCredential(requestKey)) return
      this.editFields = parseRevealedFields(this.fieldMeta, revealed).map((f) => ({ ...f }))
      this.fieldSetErrors = {}
      this.editingFieldSet = true
    } catch (error) {
      if (!this.#isCurrentCredential(requestKey)) return
      this.fieldSetFormError =
        error instanceof Error ? error.message : 'Could not load fields for editing.'
    } finally {
      this.loadingFieldSet = false
    }
  }

  cancelEditFieldSet(): void {
    this.editingFieldSet = false
    this.editFields = []
  }

  addEditField(): void {
    this.editFields = [...this.editFields, { key: '', value: '', sensitive: false }]
  }

  removeEditField(index: number): void {
    this.editFields = this.editFields.filter((_, i) => i !== index)
    this.fieldSetErrors = {}
  }

  async saveFieldSet(): Promise<void> {
    if (this.addingVersion) return
    const result = validateFieldSet(this.editFields)
    this.fieldSetErrors = result.fieldErrors
    if (!result.ok) {
      this.fieldSetFormError = result.formError ?? null
      return
    }
    this.addingVersion = true
    this.fieldSetFormError = null
    try {
      await addCredentialVersion(fetch, this.projectId, this.credentialId, {
        fields: this.editFields.map((f) => ({
          key: f.key.trim(),
          value: f.value,
          sensitive: f.sensitive,
        })),
      })
      this.editingFieldSet = false
      this.editFields = []
      await invalidateAll()
    } catch (error) {
      this.#showFieldSetSaveError(error)
    } finally {
      this.addingVersion = false
    }
  }

  #showFieldSetSaveError(error: unknown): void {
    const archivedBanner = archivedBannerFor(error)
    if (archivedBanner) {
      this.fieldSetFormError = archivedBanner
      return
    }
    const mapped = mapCredentialSubmitError(error)
    this.fieldSetFormError = mapped.errorMessage
    if (mapped.fieldKeyConflict) {
      const idx = this.editFields.findIndex(
        (f) => f.key.trim().toLowerCase() === mapped.fieldKeyConflict?.toLowerCase()
      )
      if (idx >= 0) this.fieldSetErrors = { ...this.fieldSetErrors, [idx]: mapped.errorMessage }
    }
  }

  mount(): void {
    this.#mounted = true
  }

  destroy(): void {
    this.#mounted = false
    this.#copyRequestGeneration += 1
    this.revealedValue = null
    this.revealVersion = null
    this.revealedFields = {}
    for (const timeout of this.#copyStatusTimeouts.values()) clearTimeout(timeout)
    this.#copyStatusTimeouts.clear()
  }
}

function copyableValue(
  result: Awaited<ReturnType<typeof revealCredentialValue>>,
  field: string | undefined
): string {
  const value = isFieldsValue(result)
    ? (result.fields.find((item) => item.key === field)?.value ?? undefined)
    : result.value
  if (value === undefined) throw new Error('copy value missing')
  return value
}

function copySuccessMessage(field: string | undefined): string {
  return field ? m.credential_copy_field_success({ field }) : m.credential_copy_legacy_success()
}

function copyFailureMessage(field: string | undefined): string {
  return field ? m.credential_copy_field_failure({ field }) : m.credential_copy_legacy_failure()
}

function omitKey(record: Record<string, string>, omitted: string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== omitted))
}

function fieldRevealFailureMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'unknown_field_key') {
    return 'This field no longer exists on this secret — refresh the page.'
  }
  return error instanceof Error ? error.message : 'Could not reveal this field.'
}

function revealFailureMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'insufficient_project_role') {
    return 'Your role in this project does not permit revealing secret values — ask a project admin to change your role.'
  }
  if (error instanceof ApiClientError && error.status === 403) {
    return 'You do not have permission to reveal secret values.'
  }
  return error instanceof Error ? error.message : 'Could not reveal value.'
}
