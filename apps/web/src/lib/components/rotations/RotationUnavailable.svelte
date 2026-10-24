<script lang="ts">
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'

  // Story 69.14: what the rotation detail page shows instead of its sections when the vault is
  // sealed or the rotation does not exist (or the caller cannot see it).
  let {
    sealed,
    projectId,
    credentialId,
  }: { sealed: boolean; projectId: string; credentialId: string } = $props()
</script>

{#if sealed}
  <PageAlertBanner
    title="Vault sealed"
    message={onboardingCopy.vaultSealedMessage}
    backHref={`/projects/${projectId}/credentials/${credentialId}`}
    backLabel="Back to secret"
  />
{:else}
  <PageAlertBanner
    title="Rotation not found"
    message="This rotation does not exist or you do not have access."
    backHref={`/projects/${projectId}/credentials/${credentialId}`}
    backLabel="Back to secret"
  />
{/if}
