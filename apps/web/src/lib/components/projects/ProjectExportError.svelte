<script lang="ts">
  import type { ProjectOverview } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.12: the failure message of the export section. Contract (DW-610 item 1, amending the
  // Story 62-2 D3 text): a replacement of this region component receives exactly
  // `{ project, exportError: string | null, data? }`. `exportError` is the raw API error message
  // (an `ApiClientError` message from the export endpoint, or a client `Error` message), already
  // shown to the user, fixed server strings that never contain the export key (the key is created
  // after authorization and only ever leaves in the success `X-Export-Key` header). The point
  // inside still receives `{ project }` ONLY.
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
