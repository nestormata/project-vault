<script lang="ts">
  import { buildSearchSubmitHandler } from '$lib/audit/search-form.js'
  import AuditDateRangeInputs from '$lib/components/audit/AuditDateRangeInputs.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import {
    filterSummary,
    hasActiveFilters,
    type AuditSearchFilters,
  } from './platform-audit-filters.js'

  // Story 69.10: the search form of the platform audit log. It owns the date-range error shown by
  // its own submit handler; the filters come from the page's URL.
  let { filters }: { filters: AuditSearchFilters | undefined } = $props()

  let dateRangeError = $state<string | null>(null)
  const handleSearchSubmit = buildSearchSubmitHandler((err) => {
    dateRangeError = err
  })
  const hasFilters = $derived(hasActiveFilters(filters))
  const activeFilters = $derived(filters ?? {})
</script>

<form method="GET" class="mt-4 flex flex-wrap items-end gap-3" onsubmit={handleSearchSubmit}>
  <label class="flex flex-col text-sm text-slate-700" for="filter-actionType">
    Action type
    <input
      id="filter-actionType"
      name="actionType"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.actionType ?? ''}
      aria-describedby="platform-audit-action-help"
    />
    <FormHelpText id="platform-audit-action-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-operatorId">
    Operator ID
    <input
      id="filter-operatorId"
      name="operatorId"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.operatorId ?? ''}
      aria-describedby="platform-audit-operator-help"
    />
    <FormHelpText id="platform-audit-operator-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-targetOrgId">
    Target org ID
    <input
      id="filter-targetOrgId"
      name="targetOrgId"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.targetOrgId ?? ''}
      aria-describedby="platform-audit-org-help"
    />
    <FormHelpText id="platform-audit-org-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-targetUserId">
    Target user ID
    <input
      id="filter-targetUserId"
      name="targetUserId"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.targetUserId ?? ''}
      aria-describedby="platform-audit-user-help"
    />
    <FormHelpText id="platform-audit-user-help" kind="text" />
  </label>
  <AuditDateRangeInputs
    fromValue={activeFilters.from ?? ''}
    toValue={activeFilters.to ?? ''}
    {dateRangeError}
    hasFilters={Boolean(hasFilters)}
    filterSummaryText={filterSummary(activeFilters)}
    clearHref="?"
  />
</form>
