<script lang="ts">
  import type { CredentialDetail } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
  import type { CredentialSharesListProps } from './credential-shares-props.js'
  import CredentialSharesNative from './CredentialSharesNative.svelte'

  // Story 69.2: the Shares section chrome (card, heading, intro) with PV's native sharer UI inside
  // and the region's injection point at its end. The point lives in this OUTER component so a pack
  // can replace the INNER native body (M4) and keep its own fill; replacing this outer component
  // replaces its point too (M4 semantics).
  let {
    credential,
    projectId,
    credentialId,
    orgRole,
    origin,
    shares,
    sharesTotal,
    sharesPage,
    sharesStatus,
    orgMembers,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    orgRole: CredentialPointExtras['orgRole']
    origin: string
  } & CredentialSharesListProps = $props()
</script>

<!-- @region credential.detail.shares -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Shares</h2>
  <p class="mt-1 text-sm text-slate-600">
    Share this secret's current value with another organization member via a bounded- duration link.
    They'll be notified in-app.
  </p>

  <CredentialSharesNative
    {credential}
    {projectId}
    {credentialId}
    {orgRole}
    project={pointProps.project}
    {origin}
    {shares}
    {sharesTotal}
    {sharesPage}
    {sharesStatus}
    {orgMembers}
    {pointProps}
    {data}
  /><InjectionPoint name="credential.detail.shares" props={pointProps} {data} />
</section>
