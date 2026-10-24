<script lang="ts">
  import type { ExtensionStatus } from '$lib/api/extensions.js'
  import type { ExtensionsHealthStatus } from '../../../routes/(app)/settings/extensions/+page.server.js'
  import type { Snippet } from 'svelte'
  import ExtensionsCapabilities from './ExtensionsCapabilities.svelte'
  import ExtensionsDeclarations from './ExtensionsDeclarations.svelte'
  import ExtensionsNotice from './ExtensionsNotice.svelte'
  import ExtensionsNotLoaded from './ExtensionsNotLoaded.svelte'
  import ExtensionsSummary from './ExtensionsSummary.svelte'

  // Story 69.11: the extension status page body is one sub-region per state (a notice for a denied,
  // MFA-less or failed viewer, the loaded manifest card with its summary, capabilities and
  // declarations, or the not-loaded card). `data` is the page's `__inject` map.
  let {
    allowed,
    mfaRequired,
    errorMessage,
    manifest,
    healthStatus,
    data,
    children,
  }: {
    allowed: boolean
    mfaRequired: boolean
    errorMessage: string | null
    manifest: ExtensionStatus | null
    healthStatus: ExtensionsHealthStatus | null
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if !allowed || mfaRequired || errorMessage}
  <ExtensionsNotice {allowed} {mfaRequired} {errorMessage} {data} />
{:else if manifest}
  <!-- AC-2: loaded state — the real manifest. -->
  <div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <ExtensionsSummary {manifest} {data} />

    <ExtensionsCapabilities capabilities={manifest.capabilities} {data} />

    <ExtensionsDeclarations {manifest} {data} />
  </div>
{:else}
  <ExtensionsNotLoaded {healthStatus} {data} />
{/if}
