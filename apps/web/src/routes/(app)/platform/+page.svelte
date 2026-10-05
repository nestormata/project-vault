<script lang="ts">
  import PlatformHomeHeader from '$lib/components/platform/PlatformHomeHeader.svelte'
  import NavCards from '$lib/navigation/NavCards.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import PlatformWarningsBanner from '$lib/components/platform/PlatformWarningsBanner.svelte'
  import type { PlatformPath } from '$lib/app-paths.js'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  const WARNING_MESSAGES: Record<
    string,
    { message: string; linkHref?: PlatformPath; linkText?: string }
  > = {
    audit_storage_critical: {
      message:
        'Audit log storage is at critical capacity — export and prune, or increase `AUDIT_LOG_STORAGE_LIMIT_GB`.',
      linkHref: '/platform/settings/resource-usage',
      linkText: 'Resource Usage',
    },
    key_custody_risk: {
      message:
        'Master key custody risk: a single lost key file means unrecoverable data, or the key hasn\u2019t been rotated recently.',
      linkHref: '/platform/settings',
      linkText: 'System Settings',
    },
  }
</script>

<svelte:head>
  <title>Platform Admin | Project Vault</title>
</svelte:head>

<InjectionPoint name="platform.home.before" data={data?.__inject} />
<InjectionPoint name="platform.home.header.actions" data={data?.__inject} />
{#if !data.allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class="mx-auto max-w-3xl px-4 py-8">
    <!-- @region platform.home.header -->
    <PlatformHomeHeader>
      <InjectionPoint name="platform.home.header" data={data?.__inject} />
    </PlatformHomeHeader>

    <PlatformWarningsBanner warnings={data.warnings} messages={WARNING_MESSAGES} />

    <NavCards surface="platform.index" />
  </div>
{/if}
<InjectionPoint name="platform.home.after" data={data?.__inject} />
