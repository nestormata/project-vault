<script lang="ts">
  import type { Snippet } from 'svelte'
  import AuditResultsEmpty from '$lib/components/audit/AuditResultsEmpty.svelte'
  import AuditResultsPagination from '$lib/components/audit/AuditResultsPagination.svelte'
  import AuditResultsRows from '$lib/components/audit/AuditResultsRows.svelte'
  import type { AuditEventItem } from '$lib/api/audit.js'
  import type {
    InjectionPointExtras,
    SettingsAuditResultsPointProps,
  } from '$lib/components/composition/injection-points.js'

  // Story 69.4: the event table, its empty state and the pagination of the settings audit page.
  // `children` is the page's `settings.audit.results` injection point, rendered last inside the
  // results container. Story 69.12: the empty state, the table and the pagination are sub-regions.
  let {
    events,
    filters,
    hasFilters,
    page,
    total,
    hasNext,
    pointProps,
    data,
    children,
  }: {
    events: readonly AuditEventItem[]
    filters: SettingsAuditResultsPointProps['filters'] | undefined
    hasFilters: boolean
    page: number
    total: number
    hasNext: boolean
    pointProps: InjectionPointExtras<'settings.audit.results'>
    /** The page's `__inject` map, forwarded to every sub-region's point. */
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

<div class="mt-4">
  {#if events.length === 0}
    <AuditResultsEmpty {hasFilters} {pointProps} {data} />
  {:else}
    <AuditResultsRows {events} {pointProps} {data} />

    <AuditResultsPagination {filters} {page} {total} {hasNext} {pointProps} {data} />
  {/if}{@render children?.()}
</div>
