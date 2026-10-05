<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import AuditDateRangeInputs from '$lib/components/audit/AuditDateRangeInputs.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { buildSearchSubmitHandler } from '$lib/audit/search-form.js'
  import { buildDateRangePart } from '$lib/audit/date-range.js'
  import type { SettingsAuditResultsPointProps } from '$lib/components/composition/injection-points.js'

  // Story 69.4: the Search heading and filter form of the settings audit page. `children` is the
  // page's `settings.audit.search` injection point, rendered after the form.
  let {
    filters,
    hasFilters,
    children,
  }: {
    filters: SettingsAuditResultsPointProps['filters'] | undefined
    hasFilters: boolean
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
    if (active.resourceId) parts.push(`resource = ${active.resourceId}`)
    if (active.projectId) parts.push(`project = ${active.projectId}`)
    const rangePart = buildDateRangePart(active)
    if (rangePart) parts.push(rangePart)
    return parts.join(', ')
  }
</script>

<h2 class="text-lg font-semibold text-slate-950">Search</h2>
<form method="GET" class="mt-4 flex flex-wrap items-end gap-3" onsubmit={handleSearchSubmit}>
  <label class="flex flex-col text-sm text-slate-700" for="filter-eventType">
    Event type
    <input
      id="filter-eventType"
      name="eventType"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.eventType ?? ''}
      aria-describedby="audit-event-type-help"
    />
    <FormHelpText id="audit-event-type-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-actorId">
    Actor ID
    <input
      id="filter-actorId"
      name="actorId"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.actorId ?? ''}
      aria-describedby="audit-actor-help"
    />
    <FormHelpText id="audit-actor-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-resourceId">
    Resource ID
    <input
      id="filter-resourceId"
      name="resourceId"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.resourceId ?? ''}
      aria-describedby="audit-resource-help"
    />
    <FormHelpText id="audit-resource-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-projectId">
    Project ID
    <input
      id="filter-projectId"
      name="projectId"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.projectId ?? ''}
      aria-describedby="audit-project-help"
    />
    <FormHelpText id="audit-project-help" kind="text" />
  </label>
  <AuditDateRangeInputs
    clearHref={resolve('/settings/audit')}
    fromValue={filters?.from ?? ''}
    toValue={filters?.to ?? ''}
    {dateRangeError}
    {hasFilters}
    filterSummaryText={filterSummary(filters ?? {})}
  />
</form>
{@render children?.()}
