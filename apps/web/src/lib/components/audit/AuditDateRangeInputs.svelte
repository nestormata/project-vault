<script lang="ts">
  interface Props {
    fromValue: string
    toValue: string
    dateRangeError: string | null
    hasFilters: boolean
    filterSummaryText: string
    clearHref: string
  }

  let { fromValue, toValue, dateRangeError, hasFilters, filterSummaryText, clearHref }: Props =
    $props()
</script>

<label class="flex flex-col text-sm text-slate-700" for="filter-from">
  From
  <input
    id="filter-from"
    name="from"
    type="text"
    placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
    class="rounded-lg border border-slate-300 px-2 py-1"
    value={fromValue}
  />
</label>
<label class="flex flex-col text-sm text-slate-700" for="filter-to">
  To
  <input
    id="filter-to"
    name="to"
    type="text"
    placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
    class="rounded-lg border border-slate-300 px-2 py-1"
    value={toValue}
  />
</label>
<button type="submit" class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
  Search
</button>

{#if dateRangeError}
  <p class="mt-2 text-sm text-red-700" role="alert">{dateRangeError}</p>
{/if}
{#if hasFilters}
  <p class="mt-4 text-sm text-slate-600">
    Filtered by: {filterSummaryText}
    <!-- eslint-disable svelte/no-navigation-without-resolve -->
    <a href={clearHref} class="ml-2 text-indigo-600 underline">Clear filters</a>
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </p>
{/if}
