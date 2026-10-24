<script lang="ts">
  import type { PageData } from '../../../routes/(app)/platform/settings/resource-usage/$types.js'
  import type { Snippet } from 'svelte'
  import PlatformSettingsBreadcrumb from '$lib/components/platform/PlatformSettingsBreadcrumb.svelte'
  import { AuditQuotaEditor } from './audit-quota-editor.svelte.js'
  import PlatformResourceUsageAuditEntries from './PlatformResourceUsageAuditEntries.svelte'
  import PlatformResourceUsageAuditLogStorage from './PlatformResourceUsageAuditLogStorage.svelte'
  import PlatformResourceUsageError from './PlatformResourceUsageError.svelte'
  import PlatformResourceUsageIntro from './PlatformResourceUsageIntro.svelte'
  import PlatformResourceUsageOrgStorage from './PlatformResourceUsageOrgStorage.svelte'
  import PlatformResourceUsageOrgs from './PlatformResourceUsageOrgs.svelte'
  import PlatformResourceUsageStorage from './PlatformResourceUsageStorage.svelte'
  import PlatformResourceUsageUsers from './PlatformResourceUsageUsers.svelte'

  // Story 69.14: the resource usage page is its intro plus a sub-region per card (organizations,
  // users, audit entries, storage, audit log storage, the per-organization allocation and table),
  // each hosting its own point. The page's loaded data stays `pageData`; `data` is the page's
  // `__inject` map. Story 22.3 AC-6: defensive against a malformed/missing auditStorageByOrg in an
  // otherwise-200 response, never crash the page over an additive field. The editor owns the
  // per-organization rows and the one inline quota edit in flight.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const editor = new AuditQuotaEditor(() =>
    pageData.allowed && pageData.usage ? (pageData.usage.auditStorageByOrg ?? []) : []
  )
</script>

<PlatformSettingsBreadcrumb
  allowed={pageData.allowed}
  node="breadcrumbs.platform.settings.resource-usage"
>
  <PlatformResourceUsageIntro warnings={pageData.allowed ? pageData.warnings : []} {data} />

  {#if pageData.errorMessage}
    <PlatformResourceUsageError errorMessage={pageData.errorMessage} {data} />
  {:else if pageData.usage}
    {@const u = pageData.usage}
    <div class="mt-6 space-y-6">
      <PlatformResourceUsageOrgs orgs={u.orgs} {data} />

      <PlatformResourceUsageUsers usersPerOrg={u.usersPerOrg} {data} />

      <PlatformResourceUsageAuditEntries auditLogEntries={u.auditLogEntries} {data} />

      <PlatformResourceUsageStorage storageBytes={u.storageBytes} {data} />

      <PlatformResourceUsageAuditLogStorage auditLogStorage={u.auditLogStorage} {data} />

      <PlatformResourceUsageOrgStorage usage={u} {editor} {data} />
    </div>
  {/if}
</PlatformSettingsBreadcrumb>
{@render children?.()}
