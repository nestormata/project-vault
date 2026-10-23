<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import CredentialsListFilterFields from './CredentialsListFilterFields.svelte'
  import { credentialsFilterHref, type CredentialListFilters } from './credentials-list-href.js'

  // Story 69.10: the search / status / tags filter form of the credentials list as one replaceable
  // region. Submitting drives the navigation explicitly (Story 28.1 AC1/AC2), always from page 1.
  let {
    projectId,
    filters,
    data,
  }: {
    projectId: string
    filters: CredentialListFilters
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  function handleFilterSubmit(event: SubmitEvent): void {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    const formData = new FormData(form)
    const q = String(formData.get('q') ?? '')
    const status = String(formData.get('status') ?? '')
    const tags = String(formData.get('tags') ?? '')
    void goto(resolve(credentialsFilterHref(projectId, filters, { q, status, tags, page: 1 })))
  }
</script>

<!-- @region project.credentials.filters -->
<form
  class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_auto_auto_auto_auto] sm:grid-rows-[auto_auto_auto] sm:items-start sm:gap-x-4 sm:gap-y-2"
  method="GET"
  action={resolve(`/projects/${projectId}/credentials`)}
  onsubmit={handleFilterSubmit}
>
  <CredentialsListFilterFields {filters} />

  <button
    class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white sm:col-start-4 sm:row-start-2 sm:self-start"
    type="submit"
  >
    Apply filters
  </button>
  {#if filters.q || filters.status || filters.tags}
    <a
      class="py-2 text-sm font-medium text-slate-700 underline sm:col-start-5 sm:row-start-2 sm:self-start"
      href={resolve(`/projects/${projectId}/credentials`)}
    >
      Clear
    </a>
  {/if}<InjectionPoint name="project.credentials.filters" {data} />
</form>
