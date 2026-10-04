<script lang="ts">
  import type { RotationSummary } from '@project-vault/shared'
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { rotationCopy } from '$lib/components/rotations/rotation-copy.js'
  import {
    CREDENTIAL_ARCHIVED_BANNER,
    type CredentialPointExtras,
  } from '$lib/credentials/credential-detail-helpers.js'
  import CredentialRotationRow from './CredentialRotationRow.svelte'

  // Story 69.2: the Rotation section (active rotation link, start-rotation CTA, archived-disabled
  // state, history) as one replaceable region.
  let {
    projectId,
    credentialId,
    activeRotationId,
    rotations,
    rotationsHasMore,
    rotationsPage,
    canManageRotation,
    archived,
    pointProps,
    data,
  }: {
    projectId: string
    credentialId: string
    activeRotationId: string | null
    rotations: RotationSummary[]
    rotationsHasMore: boolean
    rotationsPage: number
    canManageRotation: boolean
    archived: boolean
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region credential.detail.rotation -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Rotation</h2>

  {#if activeRotationId}
    <a
      class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
      href={resolve(
        `/projects/${projectId}/credentials/${credentialId}/rotations/${activeRotationId}`
      )}
    >
      View active rotation
    </a>
  {:else if canManageRotation && archived}
    <!-- Story 28.5 AC4/AC6: rotation initiation 410s (credential_archived) once the secret
         itself is archived — disabled here rather than linking through to a page that would
         immediately fail. -->
    <button
      type="button"
      class="mt-4 inline-block cursor-not-allowed rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white opacity-50"
      disabled
      title={CREDENTIAL_ARCHIVED_BANNER}
    >
      Start rotation
    </button>
    <p class="mt-2 text-sm text-amber-800">{CREDENTIAL_ARCHIVED_BANNER}</p>
  {:else if canManageRotation}
    <a
      class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
      href={resolve(`/projects/${projectId}/credentials/${credentialId}/rotate`)}
    >
      Start rotation
    </a>
  {:else}
    <p class="mt-3 text-sm text-slate-600">{rotationCopy.startRotationRequiresAdmin}</p>
  {/if}

  <h3 class="mt-6 font-semibold text-slate-950">History</h3>
  {#if rotations.length === 0}
    <p class="mt-3 text-sm text-slate-600">{rotationCopy.noRotationsYet}</p>
  {:else}
    <ul class="mt-4 space-y-2">
      {#each rotations as rotation (rotation.id)}
        <CredentialRotationRow {rotation} {projectId} {credentialId} />
      {/each}
    </ul>
    {#if rotationsHasMore}
      <a
        class="mt-3 inline-block text-sm font-medium text-slate-700 underline"
        href={resolve(
          `/projects/${projectId}/credentials/${credentialId}?page=${rotationsPage + 1}`
        )}
      >
        Show more
      </a>
    {/if}
  {/if}<InjectionPoint name="credential.detail.rotation" props={pointProps} {data} />
</section>
