<script lang="ts">
  import type { PageData } from '../../../routes/(app)/platform/audit/$types.js'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import type { MaintenanceModeStatus } from '$lib/api/platform.js'
  import PlatformBreadcrumb from '$lib/components/platform/PlatformBreadcrumb.svelte'
  import PlatformAuditMaintenance from './PlatformAuditMaintenance.svelte'
  import PlatformAuditSearch from './PlatformAuditSearch.svelte'
  import PlatformAuditStatusBanner from './PlatformAuditStatusBanner.svelte'
  import PlatformAuditVerify from './PlatformAuditVerify.svelte'

  // Story 69.10: the platform audit log is its intro plus four sub-regions (maintenance status, search,
  // verify integrity, maintenance mode), each hosting its own point. The page's loaded data stays
  // `pageData`; `data` is the page's `__inject` map. This component owns the maintenance status,
  // which the banner reads and the maintenance card refreshes.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  // Story 68.1 AC-3: writable $derived, so a filter navigation or invalidate resets these from
  // the new load, while the maintenance card can still update them locally.
  let maintenanceStatus = $derived<MaintenanceModeStatus | null>(
    pageData.allowed ? pageData.maintenanceStatus : null
  )
  let maintenanceStatusError = $derived<string | null>(
    pageData.allowed ? pageData.maintenanceStatusError : null
  )
</script>

<PlatformBreadcrumb allowed={pageData.allowed} node="breadcrumbs.platform.audit">
  <h1 class="text-2xl font-bold text-gray-900">Platform Operator Audit Log</h1>
  <p class="mt-2 text-sm text-gray-500">
    This is a separate log from your organization's own audit log (<a
      href={resolve('/settings/audit')}
      class="underline">Settings → Audit &amp; Compliance</a
    >) — it records platform-operator actions across all organizations, not per-org activity. There
    is no unified cross-log search in this version.
  </p>

  <PlatformAuditStatusBanner
    status={maintenanceStatus}
    statusError={maintenanceStatusError}
    {data}
  />

  {#if pageData.allowed}
    <PlatformAuditSearch
      events={pageData.events}
      total={pageData.total}
      page={pageData.page}
      hasNext={pageData.hasNext}
      eventsErrorMessage={pageData.eventsErrorMessage}
      filters={pageData.filters}
      {data}
    />
  {/if}

  <PlatformAuditVerify {data} />

  <PlatformAuditMaintenance
    bind:status={maintenanceStatus}
    bind:statusError={maintenanceStatusError}
    {data}
  />
</PlatformBreadcrumb>
{@render children?.()}
