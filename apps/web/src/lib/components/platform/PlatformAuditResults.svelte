<script lang="ts">
  import type { PlatformAuditEventItem } from '$lib/api/platform.js'
  import { buildPageHref } from '$lib/audit/page-href.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import AuditPaginationControls from '$lib/components/audit/AuditPaginationControls.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import { hasActiveFilters, type AuditSearchFilters } from './platform-audit-filters.js'

  // Story 69.10: the events table (or its error, or the empty state) with pagination as one
  // replaceable region. The page's filters decide the empty-state wording and the page links.
  let {
    events,
    total,
    page,
    hasNext,
    errorMessage,
    filters,
    data,
  }: {
    events: readonly PlatformAuditEventItem[]
    total: number
    page: number
    hasNext: boolean
    errorMessage: string | null
    filters: AuditSearchFilters | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const hasFilters = $derived(hasActiveFilters(filters))
  const pageHref = $derived(buildPageHref(filters))
</script>

<!-- @region platform.audit.results -->
<RegionFragment>
  {#if errorMessage}
    <MfaAwareErrorAlert
      message={errorMessage}
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    />
  {:else}
    <div class="mt-4">
      {#if events.length === 0}
        <p class="py-6 text-center text-slate-600">
          {hasFilters
            ? 'No platform audit events match these filters.'
            : 'No platform audit events yet.'}
        </p>
      {:else}
        <DataTable
          columns={[
            'Action type',
            'Operator',
            'Target org',
            'Target user',
            'IP address',
            'Timestamp',
          ]}
        >
          {#each events as event (event.id)}
            <tr class="border-b border-slate-100 last:border-b-0">
              <td class="px-4 py-3 font-medium text-slate-900">{event.actionType}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-600">{event.operatorId}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-600">{event.targetOrgId ?? '—'}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-600">{event.targetUserId ?? '—'}</td
              >
              <td class="px-4 py-3 text-sm text-slate-600">{event.ipAddress ?? '—'}</td>
              <td class="px-4 py-3 text-sm text-slate-600"
                >{new Date(event.timestamp).toLocaleString()}</td
              >
            </tr>
          {/each}
        </DataTable>

        <AuditPaginationControls {page} {total} {hasNext} {pageHref} />
      {/if}
    </div>
  {/if}<InjectionPoint name="platform.audit.results" {data} />
</RegionFragment>
