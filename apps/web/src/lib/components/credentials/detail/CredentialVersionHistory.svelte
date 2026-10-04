<script lang="ts">
  import type { CredentialVersionSummary } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
  import CredentialVersionRow from './CredentialVersionRow.svelte'

  // Story 69.2: the version history list as one replaceable region.
  let {
    versions,
    pointProps,
    data,
  }: {
    versions: CredentialVersionSummary[]
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region credential.detail.versions -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Version history</h2>
  {#if versions.length === 0}
    <p class="mt-3 text-sm text-slate-600">No version history available.</p>
  {:else}
    <ul class="mt-4 space-y-2">
      {#each versions as version (version.versionNumber)}
        <CredentialVersionRow {version} />
      {/each}
    </ul>
  {/if}<InjectionPoint name="credential.detail.versions" props={pointProps} {data} />
</section>
