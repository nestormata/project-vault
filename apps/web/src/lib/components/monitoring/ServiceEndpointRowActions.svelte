<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import AssetRowActions from './AssetRowActions.svelte'

  // Story 69.12: the edit and delete cell of one endpoint row, rendered only for a caller who can
  // manage endpoints. The point sits INSIDE the cell and renders once per row; a contribution at
  // `project.service-endpoints.row-actions` receives `{ project, endpoint, orgRole }`.
  let {
    project,
    endpoint,
    orgRole,
    projectId,
    onDelete,
    data,
  }: InjectionPointExtras<'project.service-endpoints.row'> & {
    projectId: string
    onDelete: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints.row-actions -->
<RegionFragment>
  <td class="px-4 py-3">
    <AssetRowActions
      editHref={`/projects/${projectId}/service-endpoints/${endpoint.id}`}
      confirmLabel="Confirm delete? This will also resolve any active alerts for it."
      {onDelete}
    /><InjectionPoint
      name="project.service-endpoints.row-actions"
      props={{ project, endpoint, orgRole }}
      {data}
    />
  </td>
</RegionFragment>
