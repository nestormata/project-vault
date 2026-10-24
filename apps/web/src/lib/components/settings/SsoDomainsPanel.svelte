<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { OrgSsoDomain } from '$lib/api/org-sso-domains.js'
  import SettingsFormGate from '$lib/components/settings/SettingsFormGate.svelte'
  import SsoDomainsAddForm from './SsoDomainsAddForm.svelte'
  import SsoDomainsList from './SsoDomainsList.svelte'

  // Story 69.10: the access gate plus its two sections (add form, mapped domains), each a sub-region
  // that owns its own state. The page hands over the few fields the gate and list need (the loader
  // only returns `domains` for an allowed viewer) and its `__inject` map as `data`.
  let {
    allowed,
    mfaRequired,
    errorMessage,
    domains,
    data,
    children,
  }: {
    allowed: boolean
    mfaRequired: boolean
    errorMessage: string | null
    domains: readonly OrgSsoDomain[]
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
<!-- AC-5: minimumRole 'admin' includes 'owner' (deliberate judgment call). -->
<SettingsFormGate
  {allowed}
  {mfaRequired}
  {errorMessage}
  deniedMessage="You need the Admin role to manage SSO domains."
  mfaMessage="Enable multi-factor authentication to manage SSO domains."
>
  <SsoDomainsAddForm {data} />
  <SsoDomainsList {domains} {data} />
</SettingsFormGate>
