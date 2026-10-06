<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { resumeRotation } from '$lib/api/rotations.js'
  import AbandonRotationControl from '$lib/components/rotations/AbandonRotationControl.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import {
    mapRotationMutationError,
    rotationNotStaleMessage,
  } from '$lib/components/rotations/rotation-copy.js'

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

  let resuming = $state(false)
  let abandoning = $state(false)
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
      return rotationNotStaleMessage
    }
    return mapRotationMutationError(error, { actionLabel }, fallback)
  }

  async function resume() {
    if (resuming || abandoning) return
    resuming = true
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
      resuming = false
    }
  }
</script>

<div class="rounded-2xl border border-amber-300 bg-amber-50 p-6" role="alert">
  <p class="font-semibold text-amber-900">
    This rotation has been inactive for too long and needs a decision: resume it, or abandon it and
    keep the previous secret value.
  </p>

  <div class="mt-4">
    <AbandonRotationControl
      {projectId}
      {credentialId}
      {rotationId}
      triggerLabel="Abandon"
      confirmCopy="Abandoning will discard the new value from this rotation. The secret will revert to showing its previous value. This cannot be undone."
      disabled={resuming}
      bind:submitting={abandoning}
      onAbandoned={() => onAbandoned()}
      {onConcurrentModification}
    >
      {#snippet beside()}
        <button
          type="button"
          class="rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          disabled={resuming || abandoning}
          onclick={() => void resume()}
        >
          Resume
        </button>
      {/snippet}
    </AbandonRotationControl>
  </div>

  <MfaAwareErrorAlert message={errorMessage} class="mt-3 text-sm text-red-800" />
</div>
