<script lang="ts">
  import type { PageData } from '../../../routes/(app)/platform/upgrade/$types.js'
  import type { Snippet } from 'svelte'
  import Breadcrumbs from '$lib/navigation/Breadcrumbs.svelte'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import PlatformUpgradeApiDocs from '$lib/components/platform/PlatformUpgradeApiDocs.svelte'
  import PlatformUpgradeCliPolicy from '$lib/components/platform/PlatformUpgradeCliPolicy.svelte'
  import PlatformUpgradeProcedure from '$lib/components/platform/PlatformUpgradeProcedure.svelte'
  import PlatformUpgradeVersion from '$lib/components/platform/PlatformUpgradeVersion.svelte'

  // Story 69.12: the page is four cards (version, CLI policy, procedure, API docs), each a
  // sub-region with its own point. `pageData` is the whole page data, `data` the page's `__inject`
  // map that the points read.
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
    <Breadcrumbs spacing="around" node="breadcrumbs.platform.upgrade" />

    <h1 class="text-2xl font-bold text-gray-900">Version &amp; Upgrade</h1>

    <PlatformUpgradeVersion
      version={pageData.version}
      versionSource={pageData.versionSource}
      {data}
    />

    <PlatformUpgradeCliPolicy cliPolicy={pageData.cliPolicy} {data} />

    <PlatformUpgradeProcedure {data} /><PlatformUpgradeApiDocs
      apiDocsEnabled={pageData.apiDocsEnabled}
      {data}
    />
  </div>
{/if}
{@render children?.()}
