<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/$types.js'
  import type { Snippet } from 'svelte'
  import BreakGlassPanel from '$lib/components/rotations/BreakGlassPanel.svelte'
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import CredentialRotateActiveNotice from './CredentialRotateActiveNotice.svelte'
  import CredentialRotateDependencies from './CredentialRotateDependencies.svelte'
  import CredentialRotateFormBody from './CredentialRotateFormBody.svelte'
  import { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the access gate plus its sections (dependent systems, the form's own sections,
  // the break-glass panel). This component owns the form state (one controller) so it survives the
  // gate flipping; the page hands over its loader data as `pageData` and its `__inject` map as `data`.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const form = new RotateFormController(() => ({
    projectId: pageData.projectId,
    credentialId: pageData.credentialId,
    fieldMeta: pageData.fieldMeta ?? null,
    activeRotationId: pageData.activeRotationId ?? null,
  }))
</script>

{@render children?.()}
{#if pageData.vaultSealed}
  <AccessNotice
    title="Vault sealed"
    message={onboardingCopy.vaultSealedMessage}
    backHref={`/projects/${pageData.projectId}/credentials/${pageData.credentialId}`}
    backLabel="Back to secret"
  />
{:else if !pageData.canManage || !pageData.dependencies}
  <AccessNotice
    title="Rotation not available"
    message="Starting a rotation requires Admin access or higher."
    backHref={`/projects/${pageData.projectId}/credentials/${pageData.credentialId}`}
    backLabel="Back to secret"
  />
{:else}
  {#if form.rotationActive}
    <CredentialRotateActiveNotice
      projectId={pageData.projectId}
      credentialId={pageData.credentialId}
      activeRotationId={pageData.activeRotationId}
    />
  {/if}

  <CredentialRotateDependencies dependencies={pageData.dependencies} {data} />

  <CredentialRotateFormBody
    {form}
    projectId={pageData.projectId}
    credentialId={pageData.credentialId}
    {data}
  />

  <BreakGlassPanel projectId={pageData.projectId} credentialId={pageData.credentialId} />
{/if}
