<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import CredentialBackLink from '$lib/components/credentials/detail/CredentialBackLink.svelte'
  import CredentialDependencies from '$lib/components/credentials/detail/CredentialDependencies.svelte'
  import CredentialHeaderCard from '$lib/components/credentials/detail/CredentialHeaderCard.svelte'
  import CredentialNotFound from '$lib/components/credentials/detail/CredentialNotFound.svelte'
  import CredentialRotationSection from '$lib/components/credentials/detail/CredentialRotationSection.svelte'
  import CredentialSharesRegion from '$lib/components/credentials/detail/CredentialSharesRegion.svelte'
  import CredentialValueSection from '$lib/components/credentials/detail/CredentialValueSection.svelte'
  import CredentialVaultSealed from '$lib/components/credentials/detail/CredentialVaultSealed.svelte'
  import CredentialVersionHistory from '$lib/components/credentials/detail/CredentialVersionHistory.svelte'
  import {
    credentialPointExtras,
    isCredentialArchived,
  } from '$lib/credentials/credential-detail-helpers.js'
  import { canManageRotations } from '$lib/components/rotations/rotation-permissions.js'

  let { data } = $props()

  // Story 69.2 AC-3: the props every point of this page receives, computed once (display data
  // only: never a revealed value, a share token or a step-up secret; never authorization input).
  const pointProps = $derived(
    credentialPointExtras({
      credential: data.credential,
      project: data.project,
      projectId: data.projectId,
      credentialId: data.credentialId,
      orgRole: data.orgRole,
    })
  )
  const canManageRotation = $derived(canManageRotations(data.orgRole))
  const isArchived = $derived(isCredentialArchived(data.credential))
</script>

<svelte:head>
  <title>{data.credential?.name ?? 'Secret'} | Project Vault</title>
</svelte:head>

<InjectionPoint name="credential.detail.before" props={pointProps} data={data.__inject} />
<InjectionPoint name="credential.detail.header.actions" props={pointProps} data={data.__inject} />
<section class="space-y-6">
  {#if data.vaultSealed}
    <CredentialVaultSealed {pointProps} data={data.__inject} />
  {:else if data.notFound || !data.credential}
    <CredentialNotFound projectId={data.projectId} {pointProps} data={data.__inject} />
  {:else}
    {@const credential = data.credential}
    <CredentialHeaderCard
      {credential}
      projectId={data.projectId}
      credentialId={data.credentialId}
      orgRole={data.orgRole}
      project={data.project}
      nudges={data.rotationRecommendedNudges ?? []}
      {pointProps}
      data={data.__inject}
    />
    <CredentialValueSection
      {credential}
      projectId={data.projectId}
      credentialId={data.credentialId}
      orgRole={data.orgRole}
      project={data.project}
      {pointProps}
      data={data.__inject}
    />
    <CredentialVersionHistory versions={data.versions} {pointProps} data={data.__inject} />
    <CredentialDependencies
      {credential}
      projectId={data.projectId}
      credentialId={data.credentialId}
      orgRole={data.orgRole}
      project={data.project}
      dependencies={data.dependencies}
      {pointProps}
      data={data.__inject}
    />
    <CredentialRotationSection
      projectId={data.projectId}
      credentialId={data.credentialId}
      activeRotationId={data.activeRotationId}
      rotations={data.rotations}
      rotationsHasMore={data.rotationsHasMore}
      rotationsPage={data.rotationsPage}
      {canManageRotation}
      archived={isArchived}
      {pointProps}
      data={data.__inject}
    />
    <CredentialSharesRegion
      {credential}
      projectId={data.projectId}
      credentialId={data.credentialId}
      orgRole={data.orgRole}
      origin={data.origin}
      shares={data.shares}
      sharesTotal={data.sharesTotal}
      sharesPage={data.sharesPage}
      sharesStatus={data.sharesStatus}
      orgMembers={data.orgMembers}
      {pointProps}
      data={data.__inject}
    />
    <!-- @region credential.detail.footer -->
    <CredentialBackLink projectId={data.projectId}>
      <InjectionPoint name="credential.detail.footer" props={pointProps} data={data.__inject} />
    </CredentialBackLink>
  {/if}
</section>
<InjectionPoint name="credential.detail.after" props={pointProps} data={data.__inject} />
