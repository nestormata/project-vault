<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import type { CredentialDetail } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import { archiveCredential, unarchiveCredential } from '$lib/api/credentials.js'
  import type { RotationRecommendedBucket } from '$lib/api/credential-shares.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import {
    CREDENTIAL_ARCHIVED_BANNER,
    canArchiveCredential,
    canRevealCredential,
    credentialKeyOf,
    isCredentialArchived,
    type CredentialPointExtras,
  } from '$lib/credentials/credential-detail-helpers.js'
  import { resetOn } from '$lib/utils/reset-on.js'
  import CredentialArchiveActions from './CredentialArchiveActions.svelte'
  import CredentialLifecycleForm from './CredentialLifecycleForm.svelte'
  import CredentialMetadataTiles from './CredentialMetadataTiles.svelte'
  import CredentialSummary from './CredentialSummary.svelte'
  import RotationRecommendedNudges from './RotationRecommendedNudges.svelte'

  // Story 69.2: the header card of the credential page. It owns what its regions share: the
  // archive busy flag and error, and the lifecycle override that lets a lifecycle save update the
  // metadata tiles without a reload. Each region inside it (summary, actions, nudges, metadata,
  // lifecycle) is its own replaceable component with its own injection point.
  let {
    credential,
    projectId,
    credentialId,
    orgRole,
    project,
    nudges,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    orgRole: CredentialPointExtras['orgRole']
    project: CredentialPointExtras['project']
    nudges: RotationRecommendedBucket[]
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 68.1 AC-3: SvelteKit reuses this component when navigating from credential A to B (same
  // route, new params) and after invalidateAll(). `credentialKey` is a primitive $derived, so it only
  // notifies when the record actually changes.
  const credentialKey = $derived(credentialKeyOf(projectId, credentialId))

  const isArchived = $derived(isCredentialArchived(credential))
  const canReveal = $derived(canRevealCredential(orgRole, project))
  // Story 28.5 AC6: authorization mirrors AC2/AC3 exactly (project-owner-or-org-owner), checked via
  // the page-load role/ownership data already available, no new API call.
  const canArchive = $derived(canArchiveCredential(orgRole, project))

  // AC-L1: local override applied after a successful lifecycle save so the metadata tiles update
  // without a full page reload; null means "show the credential's value".
  type LifecycleOverride = { expiresAt: string | null; rotationSchedule: string | null }
  let lifecycleOverride = $derived(resetOn<LifecycleOverride | null>(credentialKey, null))
  const displayExpiresAt = $derived(
    lifecycleOverride ? lifecycleOverride.expiresAt : (credential.expiresAt ?? null)
  )

  let archiveBusy = $state(false)
  let archiveError = $state<string | null>(null)

  async function onArchiveCredential(): Promise<void> {
    if (archiveBusy) return
    const confirmed = confirm(
      `Archive "${credential.name}"? Its versions, dependent-system records, rotation ` +
        'history, and past shares are all preserved. You can unarchive it later.'
    )
    if (!confirmed) return
    archiveBusy = true
    archiveError = null
    try {
      await archiveCredential(fetch, projectId, credentialId)
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'active_rotations') {
        archiveError =
          'This secret has an in-progress rotation — complete or abandon it before archiving.'
      } else if (error instanceof ApiClientError && error.code === 'active_shares') {
        const shareIds = (error.body as { shareIds?: string[] } | null)?.shareIds ?? []
        archiveError = `This secret has ${shareIds.length} active share${shareIds.length === 1 ? '' : 's'} — revoke ${shareIds.length === 1 ? 'it' : 'them'} before archiving.`
      } else {
        archiveError =
          error instanceof ApiClientError
            ? (error.message ?? 'Failed to archive secret.')
            : 'Failed to archive secret.'
      }
      archiveBusy = false
      return
    }
    try {
      await invalidateAll()
    } finally {
      archiveBusy = false
    }
  }

  async function onUnarchiveCredential(): Promise<void> {
    if (archiveBusy) return
    archiveBusy = true
    archiveError = null
    try {
      await unarchiveCredential(fetch, projectId, credentialId)
    } catch (error) {
      archiveError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to unarchive secret.')
          : 'Failed to unarchive secret.'
      archiveBusy = false
      return
    }
    try {
      await invalidateAll()
    } finally {
      archiveBusy = false
    }
  }
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <CredentialSummary {credential} archived={isArchived} {pointProps} {data} />
    <!-- @region credential.detail.actions -->
    <CredentialArchiveActions
      {canArchive}
      archived={isArchived}
      busy={archiveBusy}
      onArchive={onArchiveCredential}
      onUnarchive={onUnarchiveCredential}
    >
      <InjectionPoint name="credential.detail.actions" props={pointProps} {data} />
    </CredentialArchiveActions>
  </div>

  {#if archiveError}
    <p
      class="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {archiveError}
    </p>
  {/if}

  {#if isArchived}
    <!-- Story 28.5 AC6: persistent banner in the same visual/copy family as
         ARCHIVED_PROJECT_BANNER. -->
    <p
      class="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
      role="status"
    >
      {CREDENTIAL_ARCHIVED_BANNER}
    </p>
  {/if}

  <!-- Story 17.3 AC-16: a credential that has never been shared shows no badge at all — the
       badge's mere presence is itself the signal (matches this codebase's existing convention
       of omitting rather than graying out inapplicable UI). -->
  <!-- @region credential.detail.nudges -->
  <RotationRecommendedNudges {projectId} {credentialId} buckets={nudges}>
    <InjectionPoint name="credential.detail.nudges" props={pointProps} {data} />
  </RotationRecommendedNudges>

  <CredentialMetadataTiles {credential} {displayExpiresAt} {pointProps} {data} />

  <!-- @region credential.detail.lifecycle -->
  <CredentialLifecycleForm
    {credential}
    {projectId}
    {credentialId}
    {canReveal}
    archived={isArchived}
    onSaved={(saved) => (lifecycleOverride = saved)}
  >
    <InjectionPoint name="credential.detail.lifecycle" props={pointProps} {data} />
  </CredentialLifecycleForm>
</div>
