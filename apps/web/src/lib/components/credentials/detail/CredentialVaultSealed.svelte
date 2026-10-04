<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'

  // Story 69.2: the sealed-vault banner of the credential page as one replaceable region. It
  // receives the point props with `credential: null`.
  let {
    pointProps,
    data,
  }: {
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region credential.detail.vault-sealed -->
<PageAlertBanner title="Vault sealed" message={onboardingCopy.vaultSealedMessage}>
  <InjectionPoint name="credential.detail.vault-sealed" props={pointProps} {data} />
</PageAlertBanner>
