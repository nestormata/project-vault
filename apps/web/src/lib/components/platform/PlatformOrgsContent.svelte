<script lang="ts">
  import type { PageData } from '../../../routes/(app)/platform/settings/orgs/$types.js'
  import type { Snippet } from 'svelte'
  import type { OrgListItem } from '$lib/api/platform.js'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import PlatformOrgsCreateForm from '$lib/components/platform/PlatformOrgsCreateForm.svelte'
  import PlatformOrgsCreateStatus from '$lib/components/platform/PlatformOrgsCreateStatus.svelte'
  import PlatformOrgsList from '$lib/components/platform/PlatformOrgsList.svelte'
  import PlatformSettingsBreadcrumb from '$lib/components/platform/PlatformSettingsBreadcrumb.svelte'
  import { PlatformOrgCreate } from '$lib/components/platform/platform-org-create.svelte.js'

  // Story 69.11: the organizations page is the list and the create form (a card with its status
  // banners and the form), each a sub-region. The page's loaded data stays `pageData`; `data` is its
  // `__inject` map. `PlatformOrgCreate` owns the create form state and hands the refreshed list back.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  // Story 68.1 AC-3: writable $derived, so a new load (invalidate/navigation) resets the list
  // while the post-create refresh can still replace it locally.
  let orgs = $derived<OrgListItem[]>(pageData.allowed ? pageData.orgs : [])
  const pageError = $derived<string | null>(pageData.allowed ? pageData.errorMessage : null)
  const create = new PlatformOrgCreate((refreshed) => {
    orgs = refreshed
  })
</script>

<PlatformSettingsBreadcrumb allowed={pageData.allowed} node="breadcrumbs.platform.settings.orgs">
  <h1 class="text-2xl font-bold text-gray-900">Organizations</h1>
  <p class="mt-1 text-gray-500">Manage all organizations on this instance.</p>

  {#if pageError}
    <MfaAwareErrorAlert
      message={pageError}
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    />
  {/if}

  <PlatformOrgsList {orgs} {pageError} {data} />

  <!-- Create org form -->
  <div class="mt-8 rounded-xl border border-gray-200 bg-white p-6">
    <h2 class="text-lg font-semibold text-gray-900">Create organization</h2>

    <PlatformOrgsCreateStatus {create} {data} />

    <PlatformOrgsCreateForm {create} {data} />
  </div>
</PlatformSettingsBreadcrumb>
{@render children?.()}
