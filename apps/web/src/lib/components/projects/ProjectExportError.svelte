<script lang="ts">
  import type { ProjectOverview } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.12: the failure message of the export section. The panel owns the message text (it is
  // an API error message, never the export key).
  let {
    project,
    exportError,
    data,
  }: {
    project: ProjectOverview
    exportError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.detail.export-error -->
<RegionFragment>
  {#if exportError}
    <p class="mt-3 text-sm text-red-700">{exportError}</p>
  {/if}<InjectionPoint name="project.detail.export-error" props={{ project }} {data} />
</RegionFragment>
