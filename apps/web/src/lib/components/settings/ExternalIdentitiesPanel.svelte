<script lang="ts">
  import type { ExternalIdentitiesPageData } from '../../../routes/(app)/settings/external-identities/+page.server.js'
  import type { Snippet } from 'svelte'
  import ExternalIdentitiesLinkForm from './ExternalIdentitiesLinkForm.svelte'
  import ExternalIdentitiesList from './ExternalIdentitiesList.svelte'
  import SettingsFormGate from '$lib/components/settings/SettingsFormGate.svelte'

  // Story 69.11: the access gate plus its two sections (link form, linked identities), each a
  // sub-region that owns its own state. The page's loaded data stays `pageData`; `data` is the
  // page's `__inject` map.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: ExternalIdentitiesPageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  // Story 68.1: the loader only returns these fields when the viewer is allowed; derive them once
  // so the template reads a non-optional value (SettingsFormGate renders the body only then).
  const identities = $derived(pageData.allowed ? pageData.identities : [])
  const orgUsers = $derived(pageData.allowed ? pageData.orgUsers : [])
</script>

{@render children?.()}
<SettingsFormGate
  allowed={pageData.allowed}
  mfaRequired={pageData.allowed && pageData.mfaRequired}
  errorMessage={pageData.allowed ? pageData.errorMessage : null}
  deniedMessage="You need the Admin role to manage external identities."
  mfaMessage="Enable multi-factor authentication to manage external identities."
>
  <ExternalIdentitiesLinkForm {orgUsers} {data} />

  <ExternalIdentitiesList {identities} {data} />
</SettingsFormGate>
