<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import AuditSearchDates from '$lib/components/audit/AuditSearchDates.svelte'
  import AuditSearchActor from '$lib/components/audit/AuditSearchActor.svelte'
  import AuditSearchEvent from '$lib/components/audit/AuditSearchEvent.svelte'
  import AuditSearchResource from '$lib/components/audit/AuditSearchResource.svelte'
  import { buildSearchSubmitHandler } from '$lib/audit/search-form.js'
  import { buildDateRangePart } from '$lib/audit/date-range.js'
  import { m } from '$lib/paraglide/messages.js'
  import type {
    InjectionPointExtras,
    SettingsAuditResultsPointProps,
  } from '$lib/components/composition/injection-points.js'

  // Story 69.4: the Search heading and filter form of the settings audit page. `children` is the
  // page's `settings.audit.search` injection point, rendered after the form. Story 69.12: the form is
  // four sub-regions (event type, actor, resource and project, dates and submit).
  let {
    filters,
    hasFilters,
    pointProps,
    data,
    children,
  }: {
    filters: SettingsAuditResultsPointProps['filters'] | undefined
    hasFilters: boolean
    pointProps: InjectionPointExtras<'settings.audit.results'>
    /** The page's `__inject` map, forwarded to every sub-region's point. */
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  let dateRangeError = $state<string | null>(null)

  // AC-B2 — blocks submission client-side ("End date must be after start date") before any
  // network call when `to` is before `from`, mirroring the existing credentials/new-style
  // pre-check pattern (Story 6.4's convention).
  const handleSearchSubmit = buildSearchSubmitHandler((err) => {
    dateRangeError = err
  })

  function filterSummary(active: Record<string, string | undefined>): string {
    const parts: string[] = []
    if (active.eventType) parts.push(`event type = ${active.eventType}`)
    if (active.actorId) parts.push(`actor = ${active.actorId}`)
    if (active.actorProvider && active.actorSubject) {
      parts.push(
        m.audit_filter_summary_attributed({
          provider: active.actorProvider,
          subject: active.actorSubject,
        })
      )
    }
    if (active.resourceId) parts.push(`resource = ${active.resourceId}`)
    if (active.projectId) parts.push(`project = ${active.projectId}`)
    const rangePart = buildDateRangePart(active)
    if (rangePart) parts.push(rangePart)
    return parts.join(', ')
  }
</script>

<h2 class="text-lg font-semibold text-slate-950">Search</h2>
<form method="GET" class="mt-4 flex flex-wrap items-end gap-3" onsubmit={handleSearchSubmit}>
  <AuditSearchEvent {filters} {pointProps} {data} />
  <AuditSearchActor {filters} {pointProps} {data} />
  <AuditSearchResource {filters} {pointProps} {data} />
  <AuditSearchDates
    clearHref={resolve('/settings/audit')}
    fromValue={filters?.from ?? ''}
    toValue={filters?.to ?? ''}
    {dateRangeError}
    {hasFilters}
    filterSummaryText={filterSummary(filters ?? {})}
    {pointProps}
    {data}
  />
</form>
{@render children?.()}
