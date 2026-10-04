<script lang="ts">
  import type { CredentialDetail } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { formatDateTime } from '$lib/components/rotations/rotation-copy.js'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
  import CredentialTile from './CredentialTile.svelte'

  // Story 69.2: the four metadata tiles (tags, expires, current version, updated) as one replaceable
  // region. `displayExpiresAt` is the header card's lifecycle-aware value, so a lifecycle save shows
  // here without a reload. A contribution lands at the end of the `<dl>`, so it should itself be
  // `<div><dt>..</dt><dd>..</dd></div>` shaped.
  let {
    credential,
    displayExpiresAt,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    displayExpiresAt: string | null
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region credential.detail.metadata -->
<dl class="mt-5 grid gap-3 sm:grid-cols-2">
  <CredentialTile label="Tags">
    {credential.tags.length > 0 ? credential.tags.join(', ') : '—'}
  </CredentialTile>
  <CredentialTile label="Expires">{formatDateTime(displayExpiresAt)}</CredentialTile>
  <CredentialTile label="Current version">{credential.currentVersionNumber}</CredentialTile>
  <CredentialTile label="Updated">{formatDateTime(credential.updatedAt)}</CredentialTile
  ><InjectionPoint name="credential.detail.metadata" props={pointProps} {data} />
</dl>
