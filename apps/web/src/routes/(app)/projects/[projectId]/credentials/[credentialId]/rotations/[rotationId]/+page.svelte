<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { completeRotation, getRotation } from '$lib/api/rotations.js'
  import type { ChecklistIncompleteErrorBody } from '$lib/api/rotations.js'
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import ChecklistItemRow from '$lib/components/rotations/ChecklistItemRow.svelte'
  import StaleRecoveryBanner from '$lib/components/rotations/StaleRecoveryBanner.svelte'
  import {
    canActOnChecklist,
    canManageRotations,
  } from '$lib/components/rotations/rotation-permissions.js'
  import {
    formatDateTime,
    mapRotationMutationError,
    rotationCopy,
    rotationStatusBadgeClass,
  } from '$lib/components/rotations/rotation-copy.js'
  import type { RotationChecklistItem, RotationDetail } from '@project-vault/shared'

  const ACTIVE_STATUSES = new Set(['in_progress', 'stale_recovery'])

  let { data } = $props()

  // Local, mutable working copy: per-item confirm/fail/retry and complete/resume/abandon all
  // patch or replace this in place (D5) without a full page reload. A writable $derived resets
  // to `data.rotation` whenever SvelteKit re-runs the load (e.g. navigating between rotations),
  // while still allowing in-place reassignment for optimistic/refetched updates in between.
  let rotation = $derived<RotationDetail | null>(data.rotation)

  let concurrentBanner = $state(false)
  let pollSealedBanner = $state(false)
  let completing = $state(false)
  let completeError = $state<string | null>(null)
  let pendingItemNames = $state<string[]>([])
  let acknowledgedNoDependencies = $state(false)
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const canManage = $derived(canManageRotations(data.orgRole))
  const canAct = $derived(canActOnChecklist(data.orgRole))
  const confirmedCount = $derived(
    rotation ? rotation.checklistItems.filter((item) => item.status === 'confirmed').length : 0
  )
  const totalCount = $derived(rotation ? rotation.checklistItems.length : 0)
  const allConfirmed = $derived(totalCount > 0 && confirmedCount === totalCount)
  const canPerformItemActions = $derived(canAct && rotation?.status === 'in_progress')

  async function refetch() {
    try {
      rotation = await getRotation(fetch, data.projectId, data.credentialId, data.rotationId)
      // AC-5: clear the sealed banner the next time a poll/refresh succeeds (vault unsealed
      // again) — the poll itself is never paused or stopped by a sealed vault (D6), it just
      // self-heals once someone unseals it.
      pollSealedBanner = false
    } catch (error) {
      // AC-5: the vault can seal between page load and a poll/refresh tick — surface it via a
      // passive banner (D6) without blanking the last known rotation state (the poll failing is
      // not the same as the rotation not existing). Any other error keeps today's exact
      // behavior: best-effort, silently keep showing the last known state.
      if (error instanceof ApiClientError && error.status === 503) {
        pollSealedBanner = true
      }
    }
  }

  function handleItemUpdate(item: RotationChecklistItem, rotationVersion: number | undefined) {
    if (!rotation) return
    rotation = {
      ...rotation,
      version: rotationVersion ?? rotation.version,
      checklistItems: rotation.checklistItems.map((existing) =>
        existing.id === item.id ? item : existing
      ),
    }
  }

  async function handleConcurrentModification() {
    concurrentBanner = true
    await refetch()
    concurrentBanner = false
  }

  function handleResumed() {
    void refetch()
  }

  function handleAbandoned() {
    void refetch()
  }

  async function submitComplete() {
    if (!rotation || completing) return
    completing = true
    completeError = null
    pendingItemNames = []
    try {
      const body = totalCount === 0 ? { acknowledgedNoDependencies: true } : {}
      rotation = await completeRotation(
        fetch,
        data.projectId,
        data.credentialId,
        data.rotationId,
        body
      )
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.status === 422 && error.code === 'checklist_incomplete') {
          const body = error.body as unknown as ChecklistIncompleteErrorBody
          pendingItemNames = body.pendingItems.map((item) => item.systemName)
          completeError = 'Cannot complete — these systems still need confirmation:'
          await refetch()
        } else if (error.status === 422 && error.code === 'acknowledgement_required') {
          completeError = 'Please confirm the credential is updated everywhere before completing.'
          acknowledgedNoDependencies = false
        } else if (error.status === 409 && error.code === 'concurrent_modification') {
          await handleConcurrentModification()
        } else if (error.status === 422 && error.code === 'rotation_not_active') {
          // Ground-Truth API Surface: complete shares the same `rotation_not_active` outcome as
          // confirm/fail/retry — fires when the rotation moved out of `in_progress` between load
          // and this click. Same remediation as the concurrent-modification banner: refetch so
          // the page reflects the rotation's real, current state.
          await handleConcurrentModification()
        } else {
          // AC-8/AC-14: 503/mfa_required/429/generic — one shared helper instead of
          // re-deriving these three branches independently (D3/AC-20).
          completeError = mapRotationMutationError(
            error,
            { actionLabel: 'complete this rotation' },
            'Could not complete rotation.'
          )
        }
      } else {
        completeError = error instanceof Error ? error.message : 'Could not complete rotation.'
      }
    } finally {
      completing = false
    }
  }

  function clearPoll() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  }

  function schedulePoll() {
    clearPoll()
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (!rotation || !ACTIVE_STATUSES.has(rotation.status)) return
    pollTimer = setInterval(() => {
      void refetch()
    }, 15000)
  }

  function handleVisibilityChange() {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') clearPoll()
    else schedulePoll()
  }

  $effect(() => {
    // Re-evaluated whenever `rotation` is reassigned (status transitions in or out of the
    // pollable set, e.g. stale_recovery -> in_progress on resume, or -> completed on complete).
    rotation?.status
    schedulePoll()
  })

  onMount(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
  })

  onDestroy(() => {
    clearPoll()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  })
</script>

<svelte:head>
  <title>Rotation | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-3xl space-y-6">
  {#if data.vaultSealed}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h1 class="text-xl font-semibold text-red-900">Vault sealed</h1>
      <p class="mt-2 text-red-800">{onboardingCopy.vaultSealedMessage}</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}`)}
      >
        Back to credential
      </a>
    </div>
  {:else if data.notFound || !rotation}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h1 class="text-xl font-semibold text-red-900">Rotation not found</h1>
      <p class="mt-2 text-red-800">This rotation does not exist or you do not have access.</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}`)}
      >
        Back to credential
      </a>
    </div>
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-2xl font-bold text-slate-950">Rotation</h1>
        <span class={rotationStatusBadgeClass(rotation.status)}>{rotation.status}</span>
      </div>
      <p class="mt-2 text-sm text-slate-600">
        Initiated {formatDateTime(rotation.initiatedAt)}
        {#if rotation.completedAt}
          · Completed {formatDateTime(rotation.completedAt)}
        {/if}
      </p>
      {#if rotation.notes}
        <p class="mt-2 text-slate-700">{rotation.notes}</p>
      {/if}
      <button
        type="button"
        class="mt-3 text-sm font-medium text-slate-700 underline"
        onclick={() => void refetch()}
      >
        Refresh
      </button>
      {#if concurrentBanner}
        <p class="mt-2 text-sm text-amber-800" role="status">
          Someone else just updated this rotation. Refreshing…
        </p>
      {/if}
      {#if pollSealedBanner}
        <p class="mt-2 text-sm text-red-800" role="alert">{onboardingCopy.vaultSealedMessage}</p>
      {/if}
    </div>

    {#if !canAct}
      <p class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        {rotationCopy.checklistActionsRequireMember}
      </p>
    {/if}

    {#if rotation.status === 'stale_recovery' && canManage}
      <StaleRecoveryBanner
        projectId={data.projectId}
        credentialId={data.credentialId}
        rotationId={data.rotationId}
        onResumed={handleResumed}
        onAbandoned={handleAbandoned}
        onConcurrentModification={handleConcurrentModification}
      />
    {/if}

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Checklist</h2>
      {#if rotation.checklistItems.length === 0}
        <p class="mt-3 text-sm text-slate-600">
          No dependent systems were recorded when this rotation started.
        </p>
      {:else}
        <ul class="mt-4 space-y-3">
          {#each rotation.checklistItems as item (item.id)}
            <ChecklistItemRow
              {item}
              projectId={data.projectId}
              credentialId={data.credentialId}
              rotationId={data.rotationId}
              canAct={canPerformItemActions}
              onUpdate={handleItemUpdate}
              onConcurrentModification={handleConcurrentModification}
            />
          {/each}
        </ul>
      {/if}
    </section>

    {#if rotation.status === 'in_progress' && canManage}
      <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-slate-950">Complete rotation</h2>
        {#if totalCount === 0}
          <label class="mt-3 flex items-start gap-2 text-sm text-slate-800">
            <input type="checkbox" bind:checked={acknowledgedNoDependencies} />
            I confirm this credential is updated in all consuming systems
          </label>
        {/if}
        <button
          type="button"
          class="mt-4 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          disabled={completing || (totalCount === 0 ? !acknowledgedNoDependencies : !allConfirmed)}
          onclick={() => void submitComplete()}
        >
          {completing ? 'Completing…' : 'Complete rotation'}
        </button>
        {#if totalCount > 0 && !allConfirmed}
          <p class="mt-2 text-sm text-slate-600">
            {totalCount - confirmedCount} system(s) still need confirmation.
          </p>
        {/if}
        {#if completeError}
          <div
            class="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            role="alert"
          >
            <p>
              {completeError}
              {#if completeError.includes('MFA')}
                <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
              {/if}
            </p>
            {#if pendingItemNames.length > 0}
              <ul class="mt-1 list-disc pl-5">
                {#each pendingItemNames as name (name)}
                  <li>{name}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </section>
    {/if}

    {#if rotation.status === 'abandoned'}
      <p class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        This rotation was abandoned. The credential's previous value remains current.
      </p>
    {/if}

    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}`)}
    >
      Back to credential
    </a>
  {/if}
</section>
