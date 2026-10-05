<!--
  Shared abandon flow (Story 43-18): trigger button -> inline two-step confirm -> POST abandon ->
  error mapping. Used by StaleRecoveryBanner (stale copy, Resume beside the trigger) and the
  staged-rotation Abandon section (staged copy). Copy is passed in as props.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { RotationDetail } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import { abandonRotation } from '$lib/api/rotations.js'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import {
    mapRotationMutationError,
    rotationNotStaleMessage,
  } from '$lib/components/rotations/rotation-copy.js'

  let {
    projectId,
    credentialId,
    rotationId,
    triggerLabel,
    confirmCopy,
    onAbandoned,
    onConcurrentModification,
    onAlreadyPromoted,
    disabled = false,
    submitting = $bindable(false),
    beside,
  }: {
    projectId: string
    credentialId: string
    rotationId: string
    triggerLabel: string
    confirmCopy: string
    onAbandoned: (rotation: RotationDetail) => void
    onConcurrentModification: () => void
    /** Called after the 409 rotation_not_abandonable_after_promotion message is shown. */
    onAlreadyPromoted?: () => void
    disabled?: boolean
    submitting?: boolean
    /** Rendered next to the trigger button while the confirm step is closed (e.g. Resume). */
    beside?: Snippet
  } = $props()

  let confirming = $state(false)
  let errorMessage = $state<string | null>(null)

  const ALREADY_PROMOTED_MESSAGE =
    'This rotation was already promoted, so it can no longer be abandoned. Retire the old value instead.'

  function isApiError(error: unknown, status: number, code: string): boolean {
    return error instanceof ApiClientError && error.status === status && error.code === code
  }

  async function confirmAbandon() {
    if (submitting || disabled) return
    submitting = true
    errorMessage = null
    try {
      const updated = await abandonRotation(fetch, projectId, credentialId, rotationId)
      confirming = false
      onAbandoned(updated)
    } catch (error) {
      if (isApiError(error, 409, 'concurrent_modification')) {
        onConcurrentModification()
      } else if (isApiError(error, 422, 'rotation_not_stale')) {
        errorMessage = rotationNotStaleMessage
        confirming = false
      } else if (isApiError(error, 409, 'rotation_not_abandonable_after_promotion')) {
        errorMessage = ALREADY_PROMOTED_MESSAGE
        confirming = false
        onAlreadyPromoted?.()
      } else {
        // AC-10 (5.3): unlike the cases above, mfa_required (and 503/429/generic) must NOT close
        // the confirmation panel — the admin still wants to abandon, only the error blocks it,
        // so they stay on "Abandon anyway / Cancel" and can retry right after resolving it.
        errorMessage = mapRotationMutationError(
          error,
          { actionLabel: 'abandon this rotation' },
          'Could not abandon rotation.'
        )
      }
    } finally {
      submitting = false
    }
  }
</script>

<div>
  {#if !confirming}
    <div class="flex gap-3">
      {@render beside?.()}
      <button
        type="button"
        class="rounded-xl border border-amber-400 px-4 py-3 text-sm font-semibold text-amber-900 disabled:opacity-60"
        disabled={submitting || disabled}
        onclick={() => (confirming = true)}
      >
        {triggerLabel}
      </button>
    </div>
  {:else}
    <div class="space-y-3 rounded-xl border border-amber-400 bg-amber-100 p-4">
      <p class="text-sm text-amber-900">{confirmCopy}</p>
      <div class="flex gap-3">
        <button
          type="button"
          class="rounded-xl bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          disabled={submitting || disabled}
          onclick={() => void confirmAbandon()}
        >
          Abandon anyway
        </button>
        <button
          type="button"
          class="rounded-xl border border-amber-400 px-4 py-3 text-sm font-medium text-amber-900"
          onclick={() => (confirming = false)}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <MfaAwareErrorAlert message={errorMessage} class="mt-3 text-sm text-red-800" />
</div>
