<script lang="ts">
  import type { PageData } from '../../../routes/(app)/platform/settings/$types.js'
  import type { Snippet } from 'svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import NavLinkRow from '$lib/navigation/NavLinkRow.svelte'
  import Breadcrumbs from '$lib/navigation/Breadcrumbs.svelte'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import PlatformSettingsForm from './PlatformSettingsForm.svelte'
  import PlatformSettingsStatusToken from './PlatformSettingsStatusToken.svelte'

  // Story 69.10: the system settings page is its header plus two sub-regions (the settings form and
  // the status-token card), each hosting its own point. The page's loaded data stays `pageData`;
  // `data` is the page's `__inject` map.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{#if !pageData.allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class="mx-auto max-w-3xl px-4 py-8">
    <Breadcrumbs spacing="around" node="breadcrumbs.platform.settings" />

    <h1 class="text-2xl font-bold text-gray-900">System Settings</h1>
    <p class="mt-1 text-gray-500">Configure SMTP, notifications, and instance policy.</p>

    <div class="mt-4 flex gap-4 text-sm">
      <NavLinkRow surface="platform.settings.links" />
    </div>

    {#if pageData.errorMessage}
      <MfaAwareErrorAlert
        message={pageData.errorMessage}
        class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      />
    {:else if pageData.settings}
      <PlatformSettingsForm initialSettings={pageData.settings} {data} />
      <PlatformSettingsStatusToken
        configured={pageData.statusToken?.configured ?? false}
        createdAt={pageData.statusToken?.createdAt}
        lastUsedAt={pageData.statusToken?.lastUsedAt}
        loadFailed={pageData.statusTokenLoadFailed ?? false}
        {data}
      />
    {/if}
  </div>
{/if}
{@render children?.()}
