<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { CredentialListFilters } from './credentials-list-href.js'

  // Story 69.10: the search, status and tags fields of the credentials filter form (moved verbatim
  // from the list component; they are grid items of the form, positioned by their own classes).
  let { filters }: { filters: CredentialListFilters } = $props()
</script>

<label
  class="block text-sm font-medium text-slate-800 sm:col-start-1 sm:row-start-1"
  for="credential-search">Search</label
>
<input
  id="credential-search"
  class="w-full rounded-xl border border-slate-300 px-3 py-2 sm:col-start-1 sm:row-start-2"
  type="search"
  name="q"
  value={filters.q}
  placeholder="Search by name"
  aria-describedby="credential-search-help"
/>
<div class="sm:col-start-1 sm:row-start-3">
  <FormHelpText id="credential-search-help" kind="search" />
</div>

<label
  class="block text-sm font-medium text-slate-800 sm:col-start-2 sm:row-start-1"
  for="credential-status">Status</label
>
<select
  id="credential-status"
  class="rounded-xl border border-slate-300 px-3 py-2 sm:col-start-2 sm:row-start-2"
  name="status"
  value={filters.status}
  aria-describedby="credential-status-help"
>
  <option value="">All</option>
  <option value="active">Active</option>
  <option value="expiring">Expiring</option>
  <option value="expired">Expired</option>
</select>
<div class="sm:col-start-2 sm:row-start-3">
  <FormHelpText id="credential-status-help" kind="select" />
</div>

<label
  class="block text-sm font-medium text-slate-800 sm:col-start-3 sm:row-start-1"
  for="credential-tags">Tags</label
>
<input
  id="credential-tags"
  class="w-full rounded-xl border border-slate-300 px-3 py-2 sm:col-start-3 sm:row-start-2"
  type="text"
  name="tags"
  value={filters.tags}
  placeholder="db, prod"
  aria-describedby="credential-tags-help"
/>
<div class="space-y-1 sm:col-start-3 sm:row-start-3">
  <FormHelpText id="credential-tags-help" kind="text" />
  <p class="text-xs text-slate-500">Matches secrets with ALL of these tags.</p>
</div>
