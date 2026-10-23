<script lang="ts">
  import type { PlatformAuditEventItem } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PlatformAuditFilters from './PlatformAuditFilters.svelte'
  import PlatformAuditResults from './PlatformAuditResults.svelte'
  import type { AuditSearchFilters } from './platform-audit-filters.js'

  // Story 69.10: the Search card (filter form plus the results region) of the platform audit log as
  // one replaceable region.
  let {
    events,
    total,
    page,
    hasNext,
    eventsErrorMessage,
    filters,
    data,
  }: {
    events: readonly PlatformAuditEventItem[]
    total: number
    page: number
    hasNext: boolean
    eventsErrorMessage: string | null
    filters: AuditSearchFilters | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.audit.search -->
<div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Search</h2>
  <PlatformAuditFilters {filters} />
  <PlatformAuditResults
    {events}
    {total}
    {page}
    {hasNext}
    errorMessage={eventsErrorMessage}
    {filters}
    {data}
  /><InjectionPoint name="platform.audit.search" {data} />
</div>
