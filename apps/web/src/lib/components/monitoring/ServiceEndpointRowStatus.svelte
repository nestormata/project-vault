<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import { statusClass } from '$lib/components/dashboard/service-status.js'

  // Story 69.12: the Status cell of one endpoint row. The point sits INSIDE the cell (a fill must
  // never land between `<td>` or `<tr>` siblings) and renders once per row; a contribution at
  // `project.service-endpoints.row-status` receives `{ project, endpoint, orgRole }`.
  let {
    project,
    endpoint,
    orgRole,
    data,
  }: InjectionPointExtras<'project.service-endpoints.row'> & {
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints.row-status -->
<RegionFragment>
  <td class="px-4 py-3 text-slate-600">
    <span
      class={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${statusClass(endpoint.status)}`}
    >
      {endpoint.status}
    </span><InjectionPoint
      name="project.service-endpoints.row-status"
      props={{ project, endpoint, orgRole }}
      {data}
    />
  </td>
</RegionFragment>
