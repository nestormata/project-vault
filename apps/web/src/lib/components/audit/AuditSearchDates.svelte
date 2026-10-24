<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import AuditDateRangeInputs from './AuditDateRangeInputs.svelte'

  // Story 69.12: the date range, the Search button, the range error and the active-filter summary
  // of the settings audit search form. `AuditDateRangeInputs` is shared with the platform audit page,
  // so the region wraps it instead of turning the shared component into one.
  let {
    fromValue,
    toValue,
    dateRangeError,
    hasFilters,
    filterSummaryText,
    clearHref,
    pointProps,
    data,
  }: {
    fromValue: string
    toValue: string
    dateRangeError: string | null
    hasFilters: boolean
    filterSummaryText: string
    clearHref: string
    pointProps: InjectionPointExtras<'settings.audit.results'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit.search-dates -->
<RegionFragment>
  <AuditDateRangeInputs
    {fromValue}
    {toValue}
    {dateRangeError}
    {hasFilters}
    {filterSummaryText}
    {clearHref}
  /><InjectionPoint name="settings.audit.search-dates" props={pointProps} {data} />
</RegionFragment>
