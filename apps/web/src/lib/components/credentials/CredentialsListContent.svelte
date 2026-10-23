<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/credentials/$types.js'
  import type { Snippet } from 'svelte'
  import ProjectNotFoundBanner from '$lib/components/monitoring/ProjectNotFoundBanner.svelte'
  import CredentialsListArchivedToggle from './CredentialsListArchivedToggle.svelte'
  import CredentialsListFilters from './CredentialsListFilters.svelte'
  import CredentialsListResults from './CredentialsListResults.svelte'

  // Story 69.10: the credentials list is its not-found banner plus three sub-regions (filters,
  // archived toggle, results), each hosting its own point. The page's loaded data stays `pageData`;
  // `data` is the page's `__inject` map.
  let {
    pageData,
    canCreate,
    data,
    children,
  }: {
    pageData: PageData
    canCreate: boolean
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if pageData.notFound}
  <ProjectNotFoundBanner />
{:else}
  <CredentialsListFilters projectId={pageData.projectId} filters={pageData.filters} {data} />

  <CredentialsListArchivedToggle projectId={pageData.projectId} filters={pageData.filters} {data} />

  <CredentialsListResults
    projectId={pageData.projectId}
    filters={pageData.filters}
    items={pageData.credentials.items}
    total={pageData.credentials.total}
    {canCreate}
    {data}
  />
{/if}
