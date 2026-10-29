import { SvelteMap } from 'svelte/reactivity'
import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { ApiClientError } from '$lib/api/client.js'
import { initiateRotation } from '$lib/api/rotations.js'
import type {
  InitiateRotationRequest,
  RotationInProgressErrorBody,
  SameValueConfirmationRequiredErrorBody,
} from '$lib/api/rotations.js'
import { mapRotationMutationError } from '$lib/components/rotations/rotation-copy.js'

export interface RotateFormSource {
  projectId: string
  credentialId: string
  fieldMeta: readonly { key: string; kind?: string | undefined }[] | null
  activeRotationId: string | null
  // Story 72.10: computed by the page load; a strict boolean so no loose value can switch it on.
  hasTotpField?: boolean | undefined
}

/** The message of a start-rotation failure that is neither a confirm prompt nor a conflict. */
function startErrorMessage(error: ApiClientError): string {
  if (error.status === 400 && error.code === 'unknown_field_key') {
    // Story 13.4 AC-3 — the targeted field no longer exists on the credential (e.g. renamed
    // by another user since the form loaded).
    return error.message
  }
  if (error.status === 400 && error.code === 'field_values_target_mismatch') return error.message
  if (error.status === 422) return error.message
  if (error.status === 403 && error.code !== 'mfa_required') {
    // AC-6 edge: the existing generic role-downgrade-mid-session message is preserved for
    // any 403 that isn't specifically mfa_required — the shared helper below handles that
    // case with an action-specific "Enable MFA to ..." message instead.
    return 'You do not have permission to start a rotation.'
  }
  return mapRotationMutationError(
    error,
    { actionLabel: 'start a rotation' },
    'Could not start rotation.'
  )
}

// Story 69.14: the state and handlers of the start-rotation form, moved verbatim from
// `CredentialRotateForm` so the field selector, the value inputs, the notes, the same-value prompt
// and the actions (each a sub-region) share ONE owner. One instance per form, created by the form
// component and handed to its sections as a prop, never a module-level store.
export class RotateFormController {
  /** The loader data the form reads, evaluated at call time (it reloads after navigation). */
  readonly source: () => RotateFormSource

  // Story 13.4 AC-1: a field selector only makes sense when the credential has 2+ fields —
  // a legacy/single-field credential renders exactly today's single-textarea form, unchanged
  // (AC-7). `fieldMeta` is null while the vault is sealed / access is denied — treated the
  // same as "no selector" since the form isn't rendered in that branch anyway.
  get allFieldMeta(): readonly { key: string; kind?: string | undefined }[] {
    return this.source().fieldMeta ?? []
  }
  // Story 72.10: a one-time-password seed is replaced from the edit form, never rotated, so it is
  // not offered as a target.
  get fieldMeta(): readonly { key: string }[] {
    return this.allFieldMeta.filter((entry) => entry.kind !== 'totp')
  }
  get hasTotpField(): boolean {
    return this.source().hasTotpField === true
  }
  get showFieldSelector(): boolean {
    return this.allFieldMeta.length > 1
  }
  // Default mode is whole-secret — byte-identical to pre-13.4 behavior unless the user
  // explicitly opts into field-scoping (judgment call: the safer default preserves
  // existing behavior rather than forcing an explicit choice).
  #mode = $state<'whole' | 'specific'>('whole')
  // A whole-secret rotation would discard a one-time-password seed, so such a secret only rotates
  // specific fields.
  get rotationMode(): 'whole' | 'specific' {
    return this.hasTotpField ? 'specific' : this.#mode
  }
  set rotationMode(next: 'whole' | 'specific') {
    this.#mode = next
  }
  selectedFields = $state<string[]>([])
  // Story 13.5 AC-8: once 2+ fields are checked, one labeled value input replaces the single
  // shared textarea — this map holds each field's own typed value, keyed by field KEY (not
  // checkbox index), so unchecking/rechecking fields never misattributes a value typed for one
  // field to a different field after a selection-order change.
  readonly fieldValues = new SvelteMap<string, string>()
  get multiFieldValueMode(): boolean {
    return this.rotationMode === 'specific' && this.selectedFields.length >= 2
  }
  newValue = $state('')
  notes = $state('')
  submitting = $state(false)
  valueError = $state<string | null>(null)
  fieldSelectionError = $state<string | null>(null)
  errorMessage = $state<string | null>(null)
  conflictRotationId = $state<string | null>(null)
  // Story 13.5 AC-3: set when the server rejects a request with 409
  // same_value_confirmation_required — `sameValueConfirmField` is the affected field key, or null
  // for a whole-secret rotation. `showSameValueConfirm` shows the inline Confirm/Cancel prompt
  // instead of the generic error banner. `pendingConfirmBody` is the exact request that was
  // rejected — Confirm resubmits it verbatim plus confirmSameValue: true.
  sameValueConfirmField = $state<string | null>(null)
  showSameValueConfirm = $state(false)
  pendingConfirmBody = $state<InitiateRotationRequest | null>(null)
  // Task 6 (pre-mortem finding) — pre-empts AC-6's 409 by disabling the field
  // selector and submit button whenever the loader already found an active rotation, instead of
  // only surfacing the conflict after a failed POST.
  get rotationActive(): boolean {
    return Boolean(this.source().activeRotationId)
  }

  constructor(source: () => RotateFormSource) {
    this.source = source
  }

  toggleField(key: string): void {
    const previousSelection = this.selectedFields
    const nextSelection = previousSelection.includes(key)
      ? previousSelection.filter((k) => k !== key)
      : [...previousSelection, key]

    // Story 13.5 AC-8 (edge — unchecking a field back down to 1): moving from 2+ fields down to
    // exactly 1 reverts to the single textarea, preloaded with whatever was already typed for
    // the remaining field — no data loss on selection change.
    const remainingField = nextSelection.length === 1 ? nextSelection[0] : undefined
    if (previousSelection.length >= 2 && remainingField !== undefined) {
      this.newValue = this.fieldValues.get(remainingField) ?? this.newValue
    }
    // Moving from 0/1 field into 2+: seed the multi-value map from the single textarea's current
    // value for whichever field it represented, so that value isn't lost.
    const previousField = previousSelection.length === 1 ? previousSelection[0] : undefined
    if (previousField !== undefined && nextSelection.length >= 2) {
      this.fieldValues.set(previousField, this.newValue)
    }

    this.selectedFields = nextSelection
  }

  setFieldValue(key: string, value: string): void {
    this.fieldValues.set(key, value)
  }

  private buildMultiFieldBody(targetFields: string[], firstField: string) {
    const missing = targetFields.find((key) => !(this.fieldValues.get(key) ?? '').trim())
    if (missing) {
      this.valueError = `Enter a new value for '${missing}'`
      return null
    }
    return {
      // AC-8: newValue is set to the first field's value purely to satisfy the schema's
      // required-field constraint — never read server-side once fieldValues covers every
      // targeted field (AC-7).
      newValue: this.fieldValues.get(firstField) ?? '',
      notes: this.trimmedNotes(),
      targetFields,
      fieldValues: Object.fromEntries(
        targetFields.map((key) => [key, this.fieldValues.get(key) ?? ''])
      ),
    }
  }

  private trimmedNotes(): string | undefined {
    return this.notes.trim() ? this.notes.trim() : undefined
  }

  private buildRequestBody(): InitiateRotationRequest | null {
    const fieldScoped = this.showFieldSelector && this.rotationMode === 'specific'
    const targetFields = fieldScoped ? this.selectedFields : []
    if (fieldScoped && targetFields.length === 0) {
      this.fieldSelectionError =
        'Select at least one field to rotate, or choose "Rotate whole secret".'
      return null
    }

    const [firstField] = targetFields
    if (targetFields.length >= 2 && firstField !== undefined) {
      return this.buildMultiFieldBody(targetFields, firstField)
    }

    if (!this.newValue.trim()) {
      this.valueError = 'New value cannot be empty'
      return null
    }
    return {
      newValue: this.newValue,
      notes: this.trimmedNotes(),
      ...(targetFields.length > 0 ? { targetFields } : {}),
    }
  }

  private applyStartError(error: unknown, body: InitiateRotationRequest): void {
    if (!(error instanceof ApiClientError)) {
      this.errorMessage = error instanceof Error ? error.message : 'Could not start rotation.'
      return
    }
    if (error.status === 409 && error.code === 'same_value_confirmation_required') {
      // Story 13.5 AC-3: show the inline Confirm/Cancel prompt instead of a generic error.
      const confirmBody = error.body as SameValueConfirmationRequiredErrorBody
      this.sameValueConfirmField = confirmBody.field
      this.showSameValueConfirm = true
      this.pendingConfirmBody = body
    } else if (error.status === 409 && error.code === 'rotation_in_progress') {
      const body409 = error.body as RotationInProgressErrorBody
      this.conflictRotationId = body409.rotationId
      this.errorMessage = 'A rotation is already in progress for this secret.'
    } else {
      this.errorMessage = startErrorMessage(error)
    }
  }

  private async sendRotation(body: InitiateRotationRequest): Promise<void> {
    this.submitting = true
    try {
      const { projectId, credentialId } = this.source()
      const rotation = await initiateRotation(fetch, projectId, credentialId, body)
      await goto(
        resolve(`/projects/${projectId}/credentials/${credentialId}/rotations/${rotation.id}`)
      )
    } catch (error) {
      this.applyStartError(error, body)
    } finally {
      this.submitting = false
    }
  }

  async submitForm(): Promise<void> {
    if (this.submitting || this.rotationActive) return
    this.valueError = null
    this.fieldSelectionError = null
    this.errorMessage = null
    this.conflictRotationId = null
    this.showSameValueConfirm = false
    this.sameValueConfirmField = null
    this.pendingConfirmBody = null

    const body = this.buildRequestBody()
    if (!body) return
    await this.sendRotation(body)
  }

  // Story 13.5 AC-3: Confirm resubmits the exact same request body plus confirmSameValue: true.
  async confirmSameValueRotation(): Promise<void> {
    if (!this.pendingConfirmBody || this.submitting) return
    const body = { ...this.pendingConfirmBody, confirmSameValue: true }
    this.showSameValueConfirm = false
    this.sameValueConfirmField = null
    await this.sendRotation(body)
  }

  // Story 13.5 AC-3: Cancel dismisses the prompt and returns focus to the value input(s) with
  // the user's entered value(s) still populated — no data loss, no page reload.
  cancelSameValueConfirmation(): void {
    this.showSameValueConfirm = false
    this.sameValueConfirmField = null
    this.pendingConfirmBody = null
  }
}
