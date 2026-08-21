<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { initiateRotation } from '$lib/api/rotations.js'
  import type {
    InitiateRotationRequest,
    RotationInProgressErrorBody,
    SameValueConfirmationRequiredErrorBody,
  } from '$lib/api/rotations.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import BreakGlassPanel from '$lib/components/rotations/BreakGlassPanel.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { mapRotationMutationError } from '$lib/components/rotations/rotation-copy.js'

  let { data } = $props()

  // Story 13.4 AC-1: a field selector only makes sense when the credential has 2+ fields —
  // a legacy/single-field credential renders exactly today's single-textarea form, unchanged
  // (AC-7). `data.fieldMeta` is null while the vault is sealed / access is denied — treated the
  // same as "no selector" since the form isn't rendered in that branch anyway.
  const fieldMeta = $derived(data.fieldMeta ?? [])
  const showFieldSelector = $derived(fieldMeta.length > 1)

  // Default mode is whole-secret — byte-identical to pre-13.4 behavior unless the user
  // explicitly opts into field-scoping (Dev Notes judgment call: the safer default preserves
  // existing behavior rather than forcing an explicit choice).
  let rotationMode = $state<'whole' | 'specific'>('whole')
  let selectedFields = $state<string[]>([])

  // Story 13.5 AC-8: once 2+ fields are checked, one labeled value input replaces the single
  // shared textarea — this map holds each field's own typed value, keyed by field KEY (not
  // checkbox index), so unchecking/rechecking fields never misattributes a value typed for one
  // field to a different field after a selection-order change.
  let fieldValues = $state<Record<string, string>>({})
  const multiFieldValueMode = $derived(rotationMode === 'specific' && selectedFields.length >= 2)

  let newValue = $state('')
  let notes = $state('')
  let submitting = $state(false)
  let valueError = $state<string | null>(null)
  let fieldSelectionError = $state<string | null>(null)
  let errorMessage = $state<string | null>(null)
  let conflictRotationId = $state<string | null>(null)

  // Story 13.5 AC-3: set when the server rejects a request with 409
  // same_value_confirmation_required — `field` is the affected field key, or null for a
  // whole-secret rotation. Non-null shows the inline Confirm/Cancel prompt instead of the
  // generic error banner. `pendingConfirmBody` is the exact request that was rejected — Confirm
  // resubmits it verbatim plus confirmSameValue: true.
  let sameValueConfirmField = $state<string | null>(null)
  let showSameValueConfirm = $state(false)
  let pendingConfirmBody = $state<InitiateRotationRequest | null>(null)

  // Task 6 (Dev Notes pre-mortem elicitation) — pre-empts AC-6's 409 by disabling the field
  // selector and submit button whenever the loader already found an active rotation, instead of
  // only surfacing the conflict after a failed POST.
  const rotationActive = $derived(Boolean(data.activeRotationId))

  function toggleField(key: string) {
    const previousSelection = selectedFields
    const nextSelection = previousSelection.includes(key)
      ? previousSelection.filter((k) => k !== key)
      : [...previousSelection, key]

    // Story 13.5 AC-8 (edge — unchecking a field back down to 1): moving from 2+ fields down to
    // exactly 1 reverts to the single textarea, preloaded with whatever was already typed for
    // the remaining field — no data loss on selection change.
    if (previousSelection.length >= 2 && nextSelection.length === 1) {
      newValue = fieldValues[nextSelection[0]] ?? newValue
    }
    // Moving from 0/1 field into 2+: seed the multi-value map from the single textarea's current
    // value for whichever field it represented, so that value isn't lost.
    if (previousSelection.length === 1 && nextSelection.length >= 2) {
      fieldValues = { ...fieldValues, [previousSelection[0]]: newValue }
    }

    selectedFields = nextSelection
  }

  function buildRequestBody(): InitiateRotationRequest | null {
    const targetFields = showFieldSelector && rotationMode === 'specific' ? selectedFields : []
    if (showFieldSelector && rotationMode === 'specific' && targetFields.length === 0) {
      fieldSelectionError = 'Select at least one field to rotate, or choose "Rotate whole secret".'
      return null
    }

    if (targetFields.length >= 2) {
      const missing = targetFields.find((key) => !(fieldValues[key] ?? '').trim())
      if (missing) {
        valueError = `Enter a new value for '${missing}'`
        return null
      }
      return {
        // AC-8: newValue is set to the first field's value purely to satisfy the schema's
        // required-field constraint — never read server-side once fieldValues covers every
        // targeted field (AC-7).
        newValue: fieldValues[targetFields[0]] ?? '',
        notes: notes.trim() ? notes.trim() : undefined,
        targetFields,
        fieldValues: Object.fromEntries(targetFields.map((key) => [key, fieldValues[key] ?? ''])),
      }
    }

    if (!newValue.trim()) {
      valueError = 'New value cannot be empty'
      return null
    }
    return {
      newValue,
      notes: notes.trim() ? notes.trim() : undefined,
      ...(targetFields.length > 0 ? { targetFields } : {}),
    }
  }

  async function sendRotation(body: InitiateRotationRequest) {
    submitting = true
    try {
      const rotation = await initiateRotation(fetch, data.projectId, data.credentialId, body)
      await goto(
        resolve(
          `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${rotation.id}`
        )
      )
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.status === 409 && error.code === 'same_value_confirmation_required') {
          // Story 13.5 AC-3: show the inline Confirm/Cancel prompt instead of a generic error.
          const confirmBody = error.body as SameValueConfirmationRequiredErrorBody
          sameValueConfirmField = confirmBody.field
          showSameValueConfirm = true
          pendingConfirmBody = body
        } else if (error.status === 409 && error.code === 'rotation_in_progress') {
          const body409 = error.body as RotationInProgressErrorBody
          conflictRotationId = body409.rotationId
          errorMessage = 'A rotation is already in progress for this secret.'
        } else if (error.status === 400 && error.code === 'unknown_field_key') {
          // Story 13.4 AC-3 — the targeted field no longer exists on the credential (e.g. renamed
          // by another user since the form loaded).
          errorMessage = error.message
        } else if (error.status === 400 && error.code === 'field_values_target_mismatch') {
          errorMessage = error.message
        } else if (error.status === 422) {
          errorMessage = error.message
        } else if (error.status === 403 && error.code !== 'mfa_required') {
          // AC-6 edge: the existing generic role-downgrade-mid-session message is preserved for
          // any 403 that isn't specifically mfa_required — the shared helper below handles that
          // case with an action-specific "Enable MFA to ..." message instead.
          errorMessage = 'You do not have permission to start a rotation.'
        } else {
          errorMessage = mapRotationMutationError(
            error,
            { actionLabel: 'start a rotation' },
            'Could not start rotation.'
          )
        }
      } else {
        errorMessage = error instanceof Error ? error.message : 'Could not start rotation.'
      }
    } finally {
      submitting = false
    }
  }

  async function submitForm() {
    if (submitting || rotationActive) return
    valueError = null
    fieldSelectionError = null
    errorMessage = null
    conflictRotationId = null
    showSameValueConfirm = false
    sameValueConfirmField = null
    pendingConfirmBody = null

    const body = buildRequestBody()
    if (!body) return
    await sendRotation(body)
  }

  // Story 13.5 AC-3: Confirm resubmits the exact same request body plus confirmSameValue: true.
  async function confirmSameValueRotation() {
    if (!pendingConfirmBody || submitting) return
    const body = { ...pendingConfirmBody, confirmSameValue: true }
    showSameValueConfirm = false
    sameValueConfirmField = null
    await sendRotation(body)
  }

  // Story 13.5 AC-3: Cancel dismisses the prompt and returns focus to the value input(s) with
  // the user's entered value(s) still populated — no data loss, no page reload.
  function cancelSameValueConfirmation() {
    showSameValueConfirm = false
    sameValueConfirmField = null
    pendingConfirmBody = null
  }
</script>

<svelte:head>
  <title>Start rotation | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Rotation</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Start rotation</h1>
  </div>

  {#if data.vaultSealed}
    <AccessNotice
      title="Vault sealed"
      message={onboardingCopy.vaultSealedMessage}
      backHref={`/projects/${data.projectId}/credentials/${data.credentialId}`}
      backLabel="Back to secret"
    />
  {:else if !data.canManage || !data.dependencies}
    <AccessNotice
      title="Rotation not available"
      message="Starting a rotation requires Admin access or higher."
      backHref={`/projects/${data.projectId}/credentials/${data.credentialId}`}
      backLabel="Back to secret"
    />
  {:else}
    {#if rotationActive}
      <p
        class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        role="alert"
      >
        A rotation is already in progress for this secret.
        <a
          class="ml-1 font-medium underline"
          href={resolve(
            `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${data.activeRotationId}`
          )}
        >
          View active rotation
        </a>
      </p>
    {/if}

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Dependent systems</h2>
      {#if data.dependencies.hasDependencies}
        <p class="mt-2 text-sm text-slate-600">
          This rotation will create a checklist item for each of these {data.dependencies.items
            .length} systems:
        </p>
        <ul class="mt-3 space-y-1 text-sm text-slate-800">
          {#each data.dependencies.items as dependency (dependency.id)}
            <li>{dependency.systemName}</li>
          {/each}
        </ul>
      {:else}
        <p class="mt-2 text-sm text-slate-600">
          No dependent systems are recorded for this secret. The rotation will still be created, but
          the checklist will be empty — you'll need to explicitly acknowledge that before completing
          it.
        </p>
      {/if}
    </section>

    <form
      class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      onsubmit={(event) => {
        event.preventDefault()
        void submitForm()
      }}
    >
      {#if showFieldSelector}
        <div class="space-y-3">
          <p class="block font-medium text-slate-900">Fields to rotate</p>
          <div class="flex gap-4 text-sm">
            <label class="flex items-center gap-2">
              <input
                type="radio"
                name="rotation-mode"
                value="whole"
                checked={rotationMode === 'whole'}
                disabled={rotationActive}
                onchange={() => (rotationMode = 'whole')}
                aria-describedby="rotation-mode-help"
              />
              Rotate whole secret
            </label>
            <label class="flex items-center gap-2">
              <input
                type="radio"
                name="rotation-mode"
                value="specific"
                checked={rotationMode === 'specific'}
                disabled={rotationActive}
                onchange={() => (rotationMode = 'specific')}
                aria-describedby="rotation-mode-help"
              />
              Specific fields
            </label>
          </div>
          <FormHelpText id="rotation-mode-help" kind="radio" />
          {#if rotationMode === 'specific'}
            <ul class="space-y-1">
              {#each fieldMeta as field (field.key)}
                <li>
                  <label class="flex items-center gap-2 text-sm text-slate-800">
                    <input
                      type="checkbox"
                      aria-label={field.key}
                      checked={selectedFields.includes(field.key)}
                      disabled={rotationActive}
                      onchange={() => toggleField(field.key)}
                      aria-describedby={`rotation-field-help-${field.key}`}
                    />
                    <FormHelpText id={`rotation-field-help-${field.key}`} kind="checkbox" />
                    {field.key}
                  </label>
                </li>
              {/each}
            </ul>
            {#if fieldSelectionError}
              <p class="text-sm text-red-700">{fieldSelectionError}</p>
            {/if}
          {/if}
        </div>
      {/if}

      {#if multiFieldValueMode}
        <!-- Story 13.5 AC-8: one labeled value input per selected field, replacing the single
             shared textarea once 2+ fields are checked. -->
        <div class="space-y-4">
          {#each selectedFields as fieldKey (fieldKey)}
            <div class="space-y-2">
              <label class="block font-medium text-slate-900" for={`rotation-value-${fieldKey}`}>
                {fieldKey}
              </label>
              <textarea
                id={`rotation-value-${fieldKey}`}
                class="min-h-16 w-full rounded-xl border border-slate-300 px-3 py-3 font-mono"
                value={fieldValues[fieldKey] ?? ''}
                oninput={(event) =>
                  (fieldValues = {
                    ...fieldValues,
                    [fieldKey]: (event.currentTarget as HTMLTextAreaElement).value,
                  })}
                disabled={rotationActive}
                autocomplete="off"
                aria-describedby={`rotation-value-help-${fieldKey}`}></textarea>
              <FormHelpText id={`rotation-value-help-${fieldKey}`} kind="secret" />
            </div>
          {/each}
          {#if valueError}
            <p class="text-sm text-red-700">{valueError}</p>
          {/if}
        </div>
      {:else}
        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="rotation-new-value">New value</label>
          <textarea
            id="rotation-new-value"
            class="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-3 font-mono"
            bind:value={newValue}
            disabled={rotationActive}
            autocomplete="off"
            aria-describedby="rotation-new-value-help"></textarea>
          <FormHelpText id="rotation-new-value-help" kind="secret" />
          {#if valueError}
            <p class="text-sm text-red-700">{valueError}</p>
          {/if}
        </div>
      {/if}

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="rotation-notes">Notes</label>
        <textarea
          id="rotation-notes"
          class="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-3"
          bind:value={notes}
          aria-describedby="rotation-notes-help"></textarea>
        <FormHelpText id="rotation-notes-help" kind="text" />
      </div>

      {#if showSameValueConfirm}
        <!-- Story 13.5 AC-3: an inline confirm/cancel prompt, not a generic error banner. -->
        <div
          class="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          role="alert"
        >
          <p>
            The new value for
            {#if sameValueConfirmField}
              <code class="font-mono">{sameValueConfirmField}</code>
            {:else}
              the secret
            {/if}
            is identical to its current value. Rotate anyway?
          </p>
          <div class="flex gap-3">
            <button
              type="button"
              class="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              disabled={submitting}
              onclick={() => void confirmSameValueRotation()}
            >
              Confirm
            </button>
            <button
              type="button"
              class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800"
              onclick={cancelSameValueConfirmation}
            >
              Cancel
            </button>
          </div>
        </div>
      {/if}

      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {#if conflictRotationId}
            <a
              class="font-medium underline"
              href={resolve(
                `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${conflictRotationId}`
              )}
            >
              {errorMessage}
            </a>
          {:else}
            {errorMessage}
            {#if errorMessage.includes('MFA')}
              <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
            {/if}
          {/if}
        </p>
      {/if}

      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          class="rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          type="submit"
          disabled={submitting || rotationActive}
        >
          {submitting ? 'Starting…' : 'Start rotation'}
        </button>
        <a
          class="text-center font-medium text-slate-700 underline"
          href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}`)}
        >
          Cancel
        </a>
      </div>
    </form>

    <BreakGlassPanel projectId={data.projectId} credentialId={data.credentialId} />
  {/if}
</section>
