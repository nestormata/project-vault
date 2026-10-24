<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import AuditResultsEmptyMessage from './AuditResultsEmptyMessage.svelte'

  // Story 69.12: the message of a search that returned no events, with and without active filters.
  let {
    hasFilters,
    pointProps,
    data,
  }: {
    hasFilters: boolean
    pointProps: InjectionPointExtras<'settings.audit.results'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit.results-empty -->
<RegionFragment>
  <AuditResultsEmptyMessage {hasFilters} /><InjectionPoint
    name="settings.audit.results-empty"
    props={pointProps}
    {data}
  />
</RegionFragment>
