<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { ProjectPointProps } from '$lib/components/composition/injection-points.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import { formatCheckedAt, statusClass } from '$lib/components/dashboard/service-status.js'
  import type { OrgRole } from '$lib/monitoring/permissions.js'
  import AssetRowActions from './AssetRowActions.svelte'
  import MonitoringPauseControl from './MonitoringPauseControl.svelte'

  // Story 69.3: one endpoint row as a replaceable region. The point sits INSIDE the Monitoring cell
  // (a fill must never land between `<tr>` siblings) and renders once per row: its `data` is the
  // page's `__inject` entry, not per row, so a fill that needs per-row data reads
  // `props.endpoint.id`. A contribution at `project.service-endpoints.row` receives
  // `{ project, endpoint, orgRole }`.
  let {
    project,
    endpoint,
    orgRole,
    projectId,
    canManage,
    pauseSubmitting,
    pauseError,
    onPauseToggle,
    onDelete,
    data,
  }: {
    project: ProjectPointProps['project']
    endpoint: ServiceEndpointDetail
    orgRole: OrgRole
    projectId: string
    canManage: boolean
    pauseSubmitting: boolean
    pauseError: string | null
    onPauseToggle: (paused: boolean) => boolean | Promise<boolean>
    onDelete: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- The amber tint restores the at-a-glance paused signal the old per-row card carried;
     the "Monitoring paused" text in the cell is what actually conveys it. -->
<!-- @region project.service-endpoints.row -->
<tr
  class={`border-b border-slate-100 last:border-b-0 ${endpoint.healthCheckPaused ? 'bg-amber-50' : ''}`.trim()}
>
  <td class="px-4 py-3 font-semibold text-slate-950">
    <!-- `truncate` needs a bounded box; an auto-width <td> would just grow instead. -->
    <div class="max-w-[14rem] sm:max-w-[20rem]">
      <p class="truncate" title={endpoint.name}>{endpoint.name}</p>
      <p class="truncate text-xs font-normal text-slate-500" title={endpoint.url}>
        {endpoint.url}
      </p>
      <p class="text-xs font-normal text-slate-500">
        {formatCheckedAt(endpoint.lastCheckedAt)}
      </p>
    </div>
  </td>
  <td class="px-4 py-3 text-slate-600">
    <span
      class={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${statusClass(endpoint.status)}`}
    >
      {endpoint.status}
    </span>
  </td>
  <td class="px-4 py-3 text-slate-600">
    <p>Checked every {endpoint.checkFrequencyMinutes} min</p>
    <p>Down after {endpoint.downThresholdFailures} consecutive failures</p>
  </td>
  <!-- Bounded like the Endpoint cell: a per-row pause error is a full sentence, and in an
       auto-layout table an unbounded cell would widen the Monitoring column for every
       row — re-introducing the content-driven misalignment this story removed. -->
  <td class="w-[15rem] max-w-[15rem] px-4 py-3 text-slate-600">
    {#if endpoint.healthCheckPaused === true || endpoint.healthCheckPaused === false}
      <MonitoringPauseControl
        paused={endpoint.healthCheckPaused}
        pausedAt={endpoint.healthCheckPausedAt ?? null}
        lastKnownStatus={endpoint.status}
        {canManage}
        idSuffix={endpoint.id}
        variant="row"
        submitting={pauseSubmitting}
        errorMessage={pauseError}
        onToggle={onPauseToggle}
      />
    {/if}<InjectionPoint
      name="project.service-endpoints.row"
      props={{ project, endpoint, orgRole }}
      {data}
    />
  </td>
  {#if canManage}
    <td class="px-4 py-3">
      <AssetRowActions
        editHref={`/projects/${projectId}/service-endpoints/${endpoint.id}`}
        confirmLabel="Confirm delete? This will also resolve any active alerts for it."
        {onDelete}
      />
    </td>
  {/if}
</tr>
