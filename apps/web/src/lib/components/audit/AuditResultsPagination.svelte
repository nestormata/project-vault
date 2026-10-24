<script lang="ts">
  import { buildPageHref } from '$lib/audit/page-href.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type {
    InjectionPointExtras,
    SettingsAuditResultsPointProps,
  } from '$lib/components/composition/injection-points.js'
  import AuditPaginationControls from './AuditPaginationControls.svelte'

  // Story 69.12: the total, the page number and the Previous and Next links of the results.
  let {
    filters,
    page,
    total,
    hasNext,
    pointProps,
    data,
  }: {
    filters: SettingsAuditResultsPointProps['filters'] | undefined
    page: number
    total: number
    hasNext: boolean
    pointProps: InjectionPointExtras<'settings.audit.results'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // AC-B1 — pagination controls reflecting total/page/hasNext, preserving whatever filters are
  // already active so paging never silently drops the current search.
  const pageHref = $derived(buildPageHref(filters))
</script>

<!-- @region settings.audit.results-pagination -->
<RegionFragment>
  <AuditPaginationControls {page} {total} {hasNext} {pageHref} /><InjectionPoint
    name="settings.audit.results-pagination"
    props={pointProps}
    {data}
  />
</RegionFragment>
