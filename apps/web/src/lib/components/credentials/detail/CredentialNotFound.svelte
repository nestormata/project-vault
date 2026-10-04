<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'

  // Story 69.2: the "Secret not found" card as one replaceable region. Rendered for a 404 and for a
  // foreign credential id alike, so it receives the point props with `credential: null`.
  let {
    projectId,
    pointProps,
    data,
  }: {
    projectId: string
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region credential.detail.not-found -->
<PageAlertBanner
  title="Secret not found"
  message="This secret does not exist or you do not have access."
  backHref={`/projects/${projectId}/credentials`}
  backLabel="Back to secrets"
>
  <InjectionPoint name="credential.detail.not-found" props={pointProps} {data} />
</PageAlertBanner>
