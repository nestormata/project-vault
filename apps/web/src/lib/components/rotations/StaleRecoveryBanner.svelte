<script lang="ts">
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { abandonRotation, resumeRotation } from '$lib/api/rotations.js'
  import { mapRotationMutationError } from '$lib/components/rotations/rotation-copy.js'

  let {
    projectId,
    credentialId,
    rotationId,
    onResumed,
    onAbandoned,
    onConcurrentModification,
  }: {
    projectId: string
    credentialId: string
    rotationId: string
    onResumed: () => void
    onAbandoned: () => void
    onConcurrentModification: () => void
  } = $props()

  let submitting = $state(false)
  let confirmingAbandon = $state(false)
  let errorMessage = $state<string | null>(null)

  // AC-9/AC-10/AC-15: 503/mfa_required/429 branches are covered by the shared
  // mapRotationMutationError helper (D3/AC-20); this local helper only adds the
  // resume/abandon-specific 422 rotation_not_stale case on top of it.
  function mapError(error: unknown, fallback: string, actionLabel: string): string {
    if (
      error instanceof ApiClientError &&
      error.status === 422 &&
      error.code === 'rotation_not_stale'
    ) {
      return 'This rotation is no longer awaiting a decision — someone may have already resumed or abandoned it.'
    }
    return mapRotationMutationError(error, { actionLabel }, fallback)
  }

  async function resume() {
    if (submitting) return
    submitting = true
    errorMessage = null
    try {
      await resumeRotation(fetch, projectId, credentialId, rotationId)
      onResumed()
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status === 409 &&
        error.code === 'concurrent_modification'
      ) {
        onConcurrentModification()
      } else {
        errorMessage = mapError(error, 'Could not resume rotation.', 'resume this rotation')
      }
    } finally {
      submitting = false
    }
  }

  async function confirmAbandon() {
    if (submitting) return
    submitting = true
    errorMessage = null
    try {
      await abandonRotation(fetch, projectId, credentialId, rotationId)
      confirmingAbandon = false
      onAbandoned()
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
        error.code === 'rotation_not_stale'
      ) {
        errorMessage = mapError(error, 'Could not abandon rotation.', 'abandon this rotation')
        confirmingAbandon = false
      } else {
        // AC-10: unlike rotation_not_stale, mfa_required (and 503/429/generic) must NOT close
        // the confirmation panel — the decision to abandon is still exactly what the admin
        // wants, only the error is blocking it. The admin stays on the "Abandon anyway / Cancel"
        // step so they can retry immediately after resolving it.
        errorMessage = mapError(error, 'Could not abandon rotation.', 'abandon this rotation')
      }
    } finally {
      submitting = false
    }
  }
</script>

<div class="rounded-2xl border border-amber-300 bg-amber-50 p-6" role="alert">
  <p class="font-semibold text-amber-900">
    This rotation has been inactive for too long and needs a decision: resume it, or abandon it and
    keep the previous credential value.
  </p>

  {#if !confirmingAbandon}
    <div class="mt-4 flex gap-3">
      <button
        type="button"
        class="rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
        disabled={submitting}
        onclick={() => void resume()}
      >
        Resume
      </button>
      <button
        type="button"
        class="rounded-xl border border-amber-400 px-4 py-3 text-sm font-semibold text-amber-900 disabled:opacity-60"
        disabled={submitting}
        onclick={() => (confirmingAbandon = true)}
      >
        Abandon
      </button>
    </div>
  {:else}
    <div class="mt-4 space-y-3 rounded-xl border border-amber-400 bg-amber-100 p-4">
      <p class="text-sm text-amber-900">
        Abandoning will discard the new value from this rotation. The credential will revert to
        showing its previous value. This cannot be undone.
      </p>
      <div class="flex gap-3">
        <button
          type="button"
          class="rounded-xl bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          disabled={submitting}
          onclick={() => void confirmAbandon()}
        >
          Abandon anyway
        </button>
        <button
          type="button"
          class="rounded-xl border border-amber-400 px-4 py-3 text-sm font-medium text-amber-900"
          onclick={() => (confirmingAbandon = false)}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  {#if errorMessage}
    <p class="mt-3 text-sm text-red-800" role="alert">
      {errorMessage}
      {#if errorMessage.includes('MFA')}
        <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
      {/if}
    </p>
  {/if}
</div>
