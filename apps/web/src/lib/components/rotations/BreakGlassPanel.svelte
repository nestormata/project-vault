<script lang="ts">
  import { onDestroy } from 'svelte'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { listCredentialDependencies } from '$lib/api/credentials.js'
  import { breakGlassRotation } from '$lib/api/rotations.js'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import {
    formatDateTime,
    mapRotationMutationError,
  } from '$lib/components/rotations/rotation-copy.js'
  import type { CredentialDependency, RotationDetail } from '@project-vault/shared'

  let { projectId, credentialId }: { projectId: string; credentialId: string } = $props()

  let expanded = $state(false)
  let newValue = $state('')
  let reason = $state('')
  let reasonError = $state<string | null>(null)
  let awaitingConfirmText = $state(false)
  let confirmText = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let result = $state<RotationDetail | null>(null)
  let sweepDependencies = $state<CredentialDependency[]>([])

  function requestConfirmation() {
    reasonError = null
    errorMessage = null
    // AC-21: mirrors the server's `reason.trim().min(1)` constraint exactly — never send a
    // request the server is guaranteed to reject.
    if (!reason.trim()) {
      reasonError = 'A reason is required for break-glass rotation'
      return
    }
    awaitingConfirmText = true
  }

  function cancelConfirmation() {
    awaitingConfirmText = false
    confirmText = ''
  }

  // AC-18: collapsing the panel without submitting is a full reset of the entire unsubmitted
  // form (newValue/reason/awaitingConfirmText/confirmText/errorMessage) — reuses
  // cancelConfirmation()'s reset scope rather than a second, slightly different routine (DRY).
  // errorMessage must be cleared too: leaving a stale error (which may include an "Enable MFA"
  // link, per AC-21) from a previous failed attempt would resurface next to a freshly blank form
  // on re-expand, which is actively misleading — especially mid-incident, the one time this panel
  // is actually used.
  function toggleExpanded() {
    const wasExpanded = expanded
    expanded = !expanded
    if (wasExpanded) {
      newValue = ''
      reason = ''
      reasonError = null
      errorMessage = null
      cancelConfirmation()
    }
  }

  // AC-17: defense-in-depth — clear the plaintext value from $state before the component is torn
  // down (e.g. the admin navigates away mid-fill without submitting). Mirrors the existing
  // `onDestroy(() => { revealedValue = null; revealVersion = null })` precedent on the credential
  // detail page's own reveal-value flow.
  onDestroy(() => {
    newValue = ''
    reason = ''
  })

  async function submitBreakGlass() {
    if (submitting || confirmText !== 'CONFIRM') return
    submitting = true
    errorMessage = null
    try {
      const rotation = await breakGlassRotation(fetch, projectId, credentialId, {
        newValue,
        reason: reason.trim(),
      })
      result = rotation
      // "Ground-Truth API Surface" nuance: the break-glass response never carries the sweep
      // checklist — it's delivered only via the async notification payload. This is the UI's own
      // best-effort reconstruction, fetched independently after a successful response.
      try {
        const deps = await listCredentialDependencies(fetch, projectId, credentialId)
        sweepDependencies = deps.items.filter((dep) => !dep.archivedAt)
      } catch {
        sweepDependencies = []
      }
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status === 409 &&
        error.code === 'rotation_lock_contention'
      ) {
        errorMessage =
          'Another rotation action is in progress for this credential right now. Please wait a moment and try again.'
      } else if (error instanceof ApiClientError && error.status === 404) {
        errorMessage = 'This credential does not exist or you do not have access.'
      } else {
        errorMessage = mapRotationMutationError(
          error,
          { actionLabel: 'perform a break-glass rotation', rateLimitFraming: 'break-glass' },
          'Could not complete break-glass rotation.'
        )
      }
    } finally {
      // AC-16: clear the new-value field and reset the confirm-gate state on ANY terminal
      // outcome — success or failure — not just success. Resetting awaitingConfirmText/
      // confirmText alongside newValue is required: the value textarea is
      // `disabled={awaitingConfirmText}`, so clearing only newValue while leaving
      // awaitingConfirmText true would strand the admin staring at an empty-but-disabled
      // textarea with no way to re-paste, while the confirm button (gated only on
      // confirmText === 'CONFIRM') would still be enabled and would resubmit an empty value.
      // `reason` is deliberately NOT cleared — it is admin-controlled incident context, not a
      // secret (AC-16's edge case).
      submitting = false
      newValue = ''
      awaitingConfirmText = false
      confirmText = ''
    }
  }
</script>

<section class="rounded-2xl border-2 border-red-300 bg-red-50 p-6">
  <button
    type="button"
    class="text-left text-lg font-semibold text-red-900"
    onclick={toggleExpanded}
  >
    Emergency: break-glass rotation
  </button>

  {#if expanded}
    {#if result}
      <div class="mt-4 space-y-3" role="status">
        <p class="font-semibold text-red-900">
          Break-glass rotation complete. The new value is live now.
        </p>
        {#if result.previousVersionOverlap}
          <p class="text-sm text-red-800">
            The previous version remains accessible until {formatDateTime(
              result.previousVersionOverlap.breakGlassOverlapExpiresAt
            )} to let in-flight systems finish using it.
          </p>
        {/if}
        <div>
          <p class="text-sm font-semibold text-red-900">
            Systems that may still need the new value:
          </p>
          {#if sweepDependencies.length === 0}
            <p class="mt-1 text-sm text-red-800">
              No dependent systems are recorded for this credential.
            </p>
          {:else}
            <ul class="mt-2 space-y-1 text-sm text-red-800">
              {#each sweepDependencies as dep (dep.id)}
                <li>{dep.systemName}</li>
              {/each}
            </ul>
          {/if}
        </div>
        <a
          class="inline-block font-medium text-red-900 underline"
          href={resolve(
            `/projects/${projectId}/credentials/${credentialId}/rotations/${result.id}`
          )}
        >
          View the new rotation
        </a>
      </div>
    {:else}
      <form
        class="mt-4 space-y-4"
        onsubmit={(event) => {
          event.preventDefault()
          if (!awaitingConfirmText) requestConfirmation()
        }}
      >
        <div class="space-y-2">
          <label class="block font-medium text-red-950" for="break-glass-value">New value</label>
          <textarea
            id="break-glass-value"
            class="min-h-24 w-full rounded-xl border border-red-300 px-3 py-3 font-mono"
            bind:value={newValue}
            autocomplete="off"
            disabled={awaitingConfirmText}
            required></textarea>
        </div>

        <div class="space-y-2">
          <label class="block font-medium text-red-950" for="break-glass-reason">Reason</label>
          <textarea
            id="break-glass-reason"
            class="min-h-20 w-full rounded-xl border border-red-300 px-3 py-3"
            bind:value={reason}
            disabled={awaitingConfirmText}
            required></textarea>
          {#if reasonError}
            <p class="text-sm text-red-800" role="alert">{reasonError}</p>
          {/if}
        </div>

        {#if !awaitingConfirmText}
          <button
            type="submit"
            class="rounded-xl bg-red-700 px-4 py-3 text-sm font-semibold text-white"
          >
            Rotate immediately
          </button>
        {:else}
          <div class="space-y-3 rounded-xl border border-red-400 bg-red-100 p-4">
            <p class="text-sm text-red-900">
              This skips the checklist and takes effect immediately. Type CONFIRM to proceed.
            </p>
            <div class="space-y-2">
              <label class="block text-sm font-medium text-red-950" for="break-glass-confirm-text">
                Type CONFIRM
              </label>
              <input
                id="break-glass-confirm-text"
                class="w-full rounded-xl border border-red-300 px-3 py-2"
                type="text"
                bind:value={confirmText}
                autocomplete="off"
              />
            </div>
            <div class="flex gap-3">
              <button
                type="button"
                class="rounded-xl bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                disabled={confirmText !== 'CONFIRM' || submitting}
                onclick={() => void submitBreakGlass()}
              >
                {submitting ? 'Rotating…' : 'Confirm break-glass rotation'}
              </button>
              <button
                type="button"
                class="rounded-xl border border-red-300 px-4 py-3 text-sm font-medium text-red-900"
                onclick={cancelConfirmation}
              >
                Cancel
              </button>
            </div>
          </div>
        {/if}

        <MfaAwareErrorAlert
          message={errorMessage}
          class="rounded-xl border border-red-400 bg-red-100 p-3 text-sm text-red-900"
        />
      </form>
    {/if}
  {/if}
</section>
