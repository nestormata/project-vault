<script lang="ts">
  import { onDestroy } from 'svelte'
  import { resolve } from '$app/paths'
  import { revealCredentialValue } from '$lib/api/credentials.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { canCreateCredential } from '$lib/components/onboarding/onboarding-logic.js'
  import { canManageRotations } from '$lib/components/rotations/rotation-permissions.js'
  import {
    formatDateTime,
    rotationCopy,
    rotationStatusBadgeClass,
  } from '$lib/components/rotations/rotation-copy.js'

  let { data } = $props()

  let revealedValue = $state<string | null>(null)
  let revealVersion = $state<number | null>(null)
  let revealing = $state(false)
  let revealError = $state<string | null>(null)

  const canReveal = $derived(canCreateCredential(data.orgRole))
  const canManageRotation = $derived(canManageRotations(data.orgRole))

  onDestroy(() => {
    revealedValue = null
    revealVersion = null
  })

  async function revealValue() {
    if (revealing || !canReveal || !data.credential) return
    revealing = true
    revealError = null
    try {
      const result = await revealCredentialValue(fetch, data.projectId, data.credentialId)
      revealedValue = result.value
      revealVersion = result.versionNumber
    } catch (error) {
      revealedValue = null
      revealVersion = null
      if (error instanceof ApiClientError && error.status === 403) {
        revealError = 'You do not have permission to reveal credential values.'
      } else {
        revealError = error instanceof Error ? error.message : 'Could not reveal value.'
      }
    } finally {
      revealing = false
    }
  }

  async function copyValue() {
    if (!revealedValue) return
    try {
      await navigator.clipboard.writeText(revealedValue)
    } catch {
      // Clipboard may be unavailable in some contexts.
    }
  }
</script>

<svelte:head>
  <title>{data.credential?.name ?? 'Credential'} | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  {#if data.notFound || !data.credential}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h1 class="text-xl font-semibold text-red-900">Credential not found</h1>
      <p class="mt-2 text-red-800">This credential does not exist or you do not have access.</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/credentials`)}
      >
        Back to credentials
      </a>
    </div>
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Credential</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.credential.name}</h1>
      {#if data.credential.description}
        <p class="mt-2 text-slate-600">{data.credential.description}</p>
      {/if}
      <dl class="mt-5 grid gap-3 sm:grid-cols-2">
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Tags</dt>
          <dd class="font-medium text-slate-950">
            {data.credential.tags.length > 0 ? data.credential.tags.join(', ') : '—'}
          </dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Expires</dt>
          <dd class="font-medium text-slate-950">{formatDateTime(data.credential.expiresAt)}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Current version</dt>
          <dd class="font-medium text-slate-950">{data.credential.currentVersionNumber}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Updated</dt>
          <dd class="font-medium text-slate-950">{formatDateTime(data.credential.updatedAt)}</dd>
        </div>
      </dl>
    </div>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Secret value</h2>
      {#if canReveal}
        {#if revealedValue === null}
          <button
            class="mt-4 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            type="button"
            disabled={revealing}
            onclick={() => void revealValue()}
          >
            {revealing ? 'Revealing…' : 'Reveal value'}
          </button>
        {:else}
          <pre
            class="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{revealedValue}</pre>
          <div class="mt-3 flex gap-3">
            <button
              class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
              type="button"
              onclick={() => void copyValue()}
            >
              Copy
            </button>
            <button
              class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
              type="button"
              onclick={() => {
                revealedValue = null
                revealVersion = null
              }}
            >
              Hide
            </button>
          </div>
          {#if revealVersion !== null}
            <p class="mt-2 text-sm text-slate-600">Version {revealVersion}</p>
          {/if}
        {/if}
        {#if revealError}
          <p class="mt-3 text-sm text-red-700" role="alert">{revealError}</p>
        {/if}
      {:else}
        <p class="mt-3 text-sm text-slate-600">
          Revealing values requires Member access or higher.
        </p>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Version history</h2>
      {#if data.versions.length === 0}
        <p class="mt-3 text-sm text-slate-600">No version history available.</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each data.versions as version (version.versionNumber)}
            <li
              class="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <span class="font-medium">Version {version.versionNumber}</span>
              <span class="text-slate-600">{formatDateTime(version.createdAt)}</span>
              {#if version.isCurrent}
                <span
                  class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800"
                >
                  Current
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Rotation</h2>

      {#if data.activeRotationId}
        <a
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
          href={resolve(
            `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${data.activeRotationId}`
          )}
        >
          View active rotation
        </a>
      {:else if canManageRotation}
        <a
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
          href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}/rotate`)}
        >
          Start rotation
        </a>
      {:else}
        <p class="mt-3 text-sm text-slate-600">{rotationCopy.startRotationRequiresAdmin}</p>
      {/if}

      <h3 class="mt-6 font-semibold text-slate-950">History</h3>
      {#if data.rotations.length === 0}
        <p class="mt-3 text-sm text-slate-600">{rotationCopy.noRotationsYet}</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each data.rotations as rotation (rotation.id)}
            <li
              class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <a
                class="font-medium text-slate-950 underline"
                href={resolve(
                  `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${rotation.id}`
                )}
              >
                initiated {formatDateTime(rotation.initiatedAt)}
              </a>
              <span class={rotationStatusBadgeClass(rotation.status)}>{rotation.status}</span>
              <span class="text-slate-600">completed {formatDateTime(rotation.completedAt)}</span>
              <span class="text-slate-600">
                {rotation.confirmedCount}/{rotation.itemCount} confirmed
              </span>
            </li>
          {/each}
        </ul>
        {#if data.rotationsHasMore}
          <a
            class="mt-3 inline-block text-sm font-medium text-slate-700 underline"
            href={resolve(
              `/projects/${data.projectId}/credentials/${data.credentialId}?page=${data.rotationsPage + 1}`
            )}
          >
            Show more
          </a>
        {/if}
      {/if}
    </section>

    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/credentials`)}
    >
      Back to credentials
    </a>
  {/if}
</section>
