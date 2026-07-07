<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { initiateRotation } from '$lib/api/rotations.js'
  import type { RotationInProgressErrorBody } from '$lib/api/rotations.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import BreakGlassPanel from '$lib/components/rotations/BreakGlassPanel.svelte'
  import { mapRotationMutationError } from '$lib/components/rotations/rotation-copy.js'

  let { data } = $props()

  let newValue = $state('')
  let notes = $state('')
  let submitting = $state(false)
  let valueError = $state<string | null>(null)
  let errorMessage = $state<string | null>(null)
  let conflictRotationId = $state<string | null>(null)

  async function submitForm() {
    if (submitting) return
    valueError = null
    errorMessage = null
    conflictRotationId = null

    if (!newValue.trim()) {
      valueError = 'New value cannot be empty'
      return
    }

    submitting = true
    try {
      const rotation = await initiateRotation(fetch, data.projectId, data.credentialId, {
        newValue,
        notes: notes.trim() ? notes.trim() : undefined,
      })
      await goto(
        resolve(
          `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${rotation.id}`
        )
      )
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.status === 409 && error.code === 'rotation_in_progress') {
          const body = error.body as RotationInProgressErrorBody
          conflictRotationId = body.rotationId
          errorMessage = 'A rotation is already in progress for this credential.'
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
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h2 class="text-lg font-semibold text-red-900">Vault sealed</h2>
      <p class="mt-2 text-red-800">{onboardingCopy.vaultSealedMessage}</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}`)}
      >
        Back to credential
      </a>
    </div>
  {:else if !data.canManage || !data.dependencies}
    <AccessNotice
      title="Rotation not available"
      message="Starting a rotation requires Admin access or higher."
      backHref={`/projects/${data.projectId}/credentials/${data.credentialId}`}
      backLabel="Back to credential"
    />
  {:else}
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
          No dependent systems are recorded for this credential. The rotation will still be created,
          but the checklist will be empty — you'll need to explicitly acknowledge that before
          completing it.
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
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="rotation-new-value">New value</label>
        <textarea
          id="rotation-new-value"
          class="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-3 font-mono"
          bind:value={newValue}
          autocomplete="off"></textarea>
        {#if valueError}
          <p class="text-sm text-red-700">{valueError}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="rotation-notes">Notes</label>
        <textarea
          id="rotation-notes"
          class="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-3"
          bind:value={notes}></textarea>
      </div>

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
          disabled={submitting}
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
