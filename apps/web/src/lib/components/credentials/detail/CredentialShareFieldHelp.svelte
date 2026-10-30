<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'

  // Story 72.11 AC4: a replaceable place next to the share form's field scope selector ("Fields to
  // share"), for a pack to explain what each field means for a recipient. Only the credential's own
  // display data reaches a contribution (`CredentialPointProps`): never a share token, link or
  // step-up secret, which live in the native form's local state.
  let {
    pointProps,
    data,
  }: {
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region credential.detail.shares.field-help -->
<RegionFragment>
  <InjectionPoint name="credential.detail.shares.field-help" props={pointProps} {data} />
</RegionFragment>
