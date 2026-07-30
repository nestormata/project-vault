<!--
  Shared allowed/mfaRequired/errorMessage gate wrapping the actual form on every org-admin-gated
  /settings/* page (sso-domains, external-identities, ...) — the branching itself is deliberately
  identical across siblings, so it lives here once instead of being copy-pasted per page (jscpd
  zero-duplication gate, same convention as SettingsGateNotice).
-->
<script lang="ts">
  import { resolve } from '$app/paths'
  import FormErrorBanner from '$lib/components/monitoring/FormErrorBanner.svelte'
  import SettingsGateNotice from '$lib/components/settings/SettingsGateNotice.svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    allowed: boolean
    mfaRequired: boolean
    errorMessage: string | null
    deniedMessage: string
    mfaMessage: string
    children: Snippet
  }

  let { allowed, mfaRequired, errorMessage, deniedMessage, mfaMessage, children }: Props = $props()
</script>

{#if !allowed}
  <SettingsGateNotice
    variant="denied"
    message={deniedMessage}
    href={resolve('/settings')}
    linkText="← Back to Settings"
  />
{:else if mfaRequired}
  <SettingsGateNotice
    variant="mfa"
    message={mfaMessage}
    href={resolve('/settings/security')}
    linkText="Go to Security →"
  />
{:else if errorMessage}
  <div class="mt-8">
    <FormErrorBanner message={errorMessage} />
  </div>
{:else}
  {@render children()}
{/if}
