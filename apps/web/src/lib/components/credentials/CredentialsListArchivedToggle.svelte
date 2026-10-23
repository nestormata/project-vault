<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { credentialsFilterHref, type CredentialListFilters } from './credentials-list-href.js'

  // Story 69.10: the "Include archived secrets" toggle and its guidance as one replaceable region.
  // Story 28.5 AC5/AC6: mirrors the project list's togglingArchived re-entrancy guard exactly.
  let {
    projectId,
    filters,
    data,
  }: {
    projectId: string
    filters: CredentialListFilters
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  let togglingArchived = $state(false)
  async function toggleShowArchived(): Promise<void> {
    if (togglingArchived) return
    togglingArchived = true
    try {
      await goto(
        resolve(
          credentialsFilterHref(projectId, filters, {
            includeArchived: !filters.includeArchived,
            page: 1,
          })
        )
      )
    } finally {
      togglingArchived = false
    }
  }
</script>

<!-- @region project.credentials.archived-toggle -->
<RegionFragment>
  <div class="flex items-center gap-2">
    <input
      id="credentials-include-archived"
      type="checkbox"
      checked={filters.includeArchived}
      disabled={togglingArchived}
      aria-describedby="credentials-include-archived-help"
      onchange={() => void toggleShowArchived()}
    />
    <label for="credentials-include-archived" class="text-sm font-medium text-slate-800">
      Include archived secrets
    </label><InjectionPoint name="project.credentials.archived-toggle" {data} />
  </div>
  <p id="credentials-include-archived-help" class="text-xs text-slate-500">
    Archived secrets are hidden from this list by default. Their data, versions, and history remain
    intact and can be viewed or unarchived from the secret's own page.
  </p>
</RegionFragment>
