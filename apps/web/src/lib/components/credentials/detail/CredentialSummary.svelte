<script lang="ts">
  import type { CredentialDetail } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
  import ArchivedBadge from '$lib/components/projects/ArchivedBadge.svelte'

  // Story 69.2: the title row of the header card ("Secret" label, name, Archived badge, description)
  // as one replaceable region.
  let {
    credential,
    archived,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    archived: boolean
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region credential.detail.summary -->
<div>
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Secret</p>
  <div class="mt-2 flex items-center gap-2">
    <h1 class="text-3xl font-bold text-slate-950">{credential.name}</h1>
    {#if archived}<ArchivedBadge />{/if}
  </div>
  {#if credential.description}
    <p class="mt-2 text-slate-600">{credential.description}</p>
  {/if}<InjectionPoint name="credential.detail.summary" props={pointProps} {data} />
</div>
