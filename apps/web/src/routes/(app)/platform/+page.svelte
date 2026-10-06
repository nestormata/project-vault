<script lang="ts">
  import PlatformHomeHeader from '$lib/components/platform/PlatformHomeHeader.svelte'
  import NavCardsRegion from '$lib/components/shell/NavCardsRegion.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import PlatformOperatorNoticeRegion from '$lib/components/platform/PlatformOperatorNoticeRegion.svelte'
  import PlatformWarningsRegion from '$lib/components/platform/PlatformWarningsRegion.svelte'
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
  <!-- @region platform.home.operator-notice -->
  <PlatformOperatorNoticeRegion>
    <InjectionPoint name="platform.home.operator-notice" data={data?.__inject} />
  </PlatformOperatorNoticeRegion>
{:else}
  <div class="mx-auto max-w-3xl px-4 py-8">
    <!-- @region platform.home.header -->
    <PlatformHomeHeader>
      <InjectionPoint name="platform.home.header" data={data?.__inject} />
    </PlatformHomeHeader>

    <!-- @region platform.home.warnings -->
    <PlatformWarningsRegion warnings={data.warnings} messages={WARNING_MESSAGES}>
      <InjectionPoint name="platform.home.warnings" data={data?.__inject} />
    </PlatformWarningsRegion>

    <!-- @region platform.home.nav-cards -->
    <NavCardsRegion surface="platform.index">
      <InjectionPoint name="platform.home.nav-cards" data={data?.__inject} />
    </NavCardsRegion>
  </div>
{/if}
<InjectionPoint name="platform.home.after" data={data?.__inject} />
