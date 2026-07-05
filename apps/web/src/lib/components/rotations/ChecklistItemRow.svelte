<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import {
    confirmChecklistItem,
    failChecklistItem,
    retryChecklistItem,
    type AlreadyConfirmedErrorBody,
    type MaxRetriesExceededErrorBody,
  } from '$lib/api/rotations.js'
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import { checklistItemStatusBadgeClass, checklistItemStatusLabel } from './rotation-copy.js'
  import type { RotationChecklistItem } from '@project-vault/shared'

  let {
    item,
    projectId,
    credentialId,
    rotationId,
    canAct,
    onUpdate,
    onConcurrentModification,
  }: {
    item: RotationChecklistItem
    projectId: string
    credentialId: string
    rotationId: string
    canAct: boolean
    onUpdate: (item: RotationChecklistItem, rotationVersion: number | undefined) => void
    onConcurrentModification: () => void
  } = $props()

  let submitting = $state(false)
  let showFailForm = $state(false)
  let failReason = $state('')
  let failReasonError = $state<string | null>(null)
  let retryScheduledAt = $state('')
  let noticeMessage = $state<string | null>(null)
  let maxRetriesMessage = $state<string | null>(null)
  let errorMessage = $state<string | null>(null)

  function clearMessages() {
    errorMessage = null
    noticeMessage = null
    maxRetriesMessage = null
  }

  // AC-8: "confirmedBy (resolved to a display name if available, else the raw id truncated ...
  // falling back gracefully if no name-resolution endpoint is wired for this id)". This story
  // wires no name-resolution endpoint, so the fallback (truncated id) is always what renders.
  function shortActorId(id: string): string {
    return id.length > 8 ? `${id.slice(0, 8)}…` : id
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  function handleSealedOrGeneric(error: unknown, fallback: string): string {
    if (error instanceof ApiClientError) {
      if (error.status === 503) return onboardingCopy.vaultSealedMessage
      return error.message
    }
    return error instanceof Error ? error.message : fallback
  }

  async function confirm() {
    if (submitting) return
    submitting = true
    clearMessages()
    try {
      const result = await confirmChecklistItem(
        fetch,
        projectId,
        credentialId,
        rotationId,
        item.id,
        {}
      )
      onUpdate(result.item, result.rotationVersion)
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status === 409 &&
        error.code === 'already_confirmed'
      ) {
        const body = error.body as unknown as AlreadyConfirmedErrorBody
        noticeMessage = `Already confirmed by ${body.confirmedBy ?? 'someone'} at ${body.confirmedAt ?? 'an earlier time'}`
        onUpdate(
          {
            ...item,
            status: 'confirmed',
            confirmedBy: body.confirmedBy,
            confirmedAt: body.confirmedAt,
          },
          undefined
        )
      } else if (
        error instanceof ApiClientError &&
        error.status === 409 &&
        error.code === 'concurrent_modification'
      ) {
        onConcurrentModification()
      } else if (
        error instanceof ApiClientError &&
        error.status === 422 &&
        error.code === 'rotation_not_active'
      ) {
        // Ground-Truth API Surface documents this code for confirm/fail/retry — it fires when
        // the rotation itself moved out of `in_progress` (completed/abandoned/stale) between
        // this row rendering and the click landing. Same remediation as AC-15's concurrent-
        // modification banner: surface it and refetch so stale action buttons disappear.
        onConcurrentModification()
      } else {
        errorMessage = handleSealedOrGeneric(error, 'Could not confirm item.')
      }
    } finally {
      submitting = false
    }
  }

  function startFail() {
    showFailForm = true
    failReasonError = null
    clearMessages()
  }

  function cancelFail() {
    showFailForm = false
    failReason = ''
    retryScheduledAt = ''
    failReasonError = null
  }

  async function submitFail() {
    if (submitting) return
    if (!failReason.trim()) {
      failReasonError = 'A reason is required'
      return
    }
    submitting = true
    clearMessages()
    try {
      const result = await failChecklistItem(fetch, projectId, credentialId, rotationId, item.id, {
        reason: failReason.trim(),
        retryScheduledAt: retryScheduledAt ? new Date(retryScheduledAt).toISOString() : null,
      })
      onUpdate(result.item, result.rotationVersion)
      cancelFail()
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status === 409 &&
        error.code === 'concurrent_modification'
      ) {
        onConcurrentModification()
      } else if (
        error instanceof ApiClientError &&
        error.status === 422 &&
        error.code === 'rotation_not_active'
      ) {
        onConcurrentModification()
      } else {
        errorMessage = handleSealedOrGeneric(error, 'Could not report a problem.')
      }
    } finally {
      submitting = false
    }
  }

  async function retry() {
    if (submitting) return
    submitting = true
    clearMessages()
    try {
      const result = await retryChecklistItem(fetch, projectId, credentialId, rotationId, item.id)
      onUpdate(result.item, result.rotationVersion)
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status === 422 &&
        error.code === 'max_retries_exceeded'
      ) {
        const body = error.body as unknown as MaxRetriesExceededErrorBody
        maxRetriesMessage = `This system has been retried the maximum number of times (${body.maxRetries}). Ask an admin to confirm it directly once verified, or escalate.`
        onUpdate(
          { ...item, status: 'max_retries_exceeded', retryCount: body.retryCount },
          undefined
        )
      } else if (
        error instanceof ApiClientError &&
        error.status === 409 &&
        error.code === 'concurrent_modification'
      ) {
        onConcurrentModification()
      } else if (
        error instanceof ApiClientError &&
        error.status === 422 &&
        error.code === 'rotation_not_active'
      ) {
        onConcurrentModification()
      } else {
        errorMessage = handleSealedOrGeneric(error, 'Could not retry item.')
      }
    } finally {
      submitting = false
    }
  }
</script>

<li class="rounded-xl border border-slate-200 p-4 text-sm">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <span class="font-medium text-slate-950">{item.systemName}</span>
    <span class={checklistItemStatusBadgeClass(item.status)}>
      {checklistItemStatusLabel(item.status)}
    </span>
  </div>

  {#if item.status === 'confirmed' && item.confirmedAt}
    <p class="mt-1 text-xs text-slate-600">
      confirmed{item.confirmedBy ? ` by ${shortActorId(item.confirmedBy)}` : ''} at {formatDate(
        item.confirmedAt
      )}
    </p>
  {/if}
  {#if item.retryCount > 0}
    <p class="mt-1 text-xs text-slate-600">retry: {item.retryCount}</p>
  {/if}
  {#if item.lastFailureReason}
    <p class="mt-1 text-slate-700">{item.lastFailureReason}</p>
  {/if}

  {#if canAct}
    <div class="mt-3 flex flex-wrap gap-2">
      {#if item.status === 'unconfirmed'}
        <button
          type="button"
          class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={submitting}
          onclick={() => void confirm()}
        >
          Confirm
        </button>
        <button
          type="button"
          class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-60"
          disabled={submitting}
          onclick={startFail}
        >
          Report a problem
        </button>
      {:else if item.status === 'failed'}
        <button
          type="button"
          class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-60"
          disabled={submitting}
          onclick={() => void retry()}
        >
          Retry
        </button>
        <button
          type="button"
          class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={submitting}
          onclick={() => void confirm()}
        >
          Confirm
        </button>
      {:else if item.status === 'max_retries_exceeded'}
        <button
          type="button"
          class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={submitting}
          onclick={() => void confirm()}
        >
          Confirm
        </button>
      {/if}
    </div>

    {#if showFailForm}
      <div class="mt-3 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <label class="block text-sm font-medium text-slate-900" for={`fail-reason-${item.id}`}>
          Reason
        </label>
        <textarea
          id={`fail-reason-${item.id}`}
          class="w-full rounded-xl border border-slate-300 px-3 py-2"
          bind:value={failReason}></textarea>
        {#if failReasonError}
          <p class="text-sm text-red-700">{failReasonError}</p>
        {/if}
        <label class="block text-sm font-medium text-slate-900" for={`retry-at-${item.id}`}>
          Retry at (optional)
        </label>
        <input
          id={`retry-at-${item.id}`}
          class="rounded-xl border border-slate-300 px-3 py-2"
          type="datetime-local"
          bind:value={retryScheduledAt}
        />
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={submitting}
            onclick={() => void submitFail()}
          >
            Submit
          </button>
          <button
            type="button"
            class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium"
            onclick={cancelFail}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}
  {/if}

  {#if noticeMessage}
    <p class="mt-2 text-sm text-amber-800" role="status">{noticeMessage}</p>
  {/if}
  {#if maxRetriesMessage}
    <p class="mt-2 text-sm text-red-800" role="alert">{maxRetriesMessage}</p>
  {/if}
  {#if errorMessage}
    <p class="mt-2 text-sm text-red-700" role="alert">{errorMessage}</p>
  {/if}
</li>
