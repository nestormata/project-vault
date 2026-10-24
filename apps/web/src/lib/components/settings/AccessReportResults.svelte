<script lang="ts">
  import type { AccessReportResult } from '$lib/api/audit.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import ProjectsListCell from '$lib/components/tables/ProjectsListCell.svelte'
  import AccessReportPagination from './AccessReportPagination.svelte'

  // Story 69.11: the users of a generated access report (the empty notice, or the table followed by
  // its pagination) as one replaceable region.
  let {
    report,
    asOf,
    page,
    data,
  }: {
    report: AccessReportResult
    asOf: string | undefined
    page: number | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-access-report.results -->
<RegionFragment>
  {#if report.users.length === 0}
    <p class="mt-4 py-6 text-center text-slate-600">No users found for this report.</p>
  {:else}
    <div class="mt-4">
      <DataTable columns={['User', 'Org role', 'Status', 'Projects']}>
        {#each report.users as user (user.userId)}
          <tr class="border-b border-slate-100 align-top last:border-b-0">
            <td class="px-4 py-3 font-medium text-slate-900">{user.displayName}</td>
            <td class="px-4 py-3 text-slate-600">{user.orgRole}</td>
            <td class="px-4 py-3">
              {#if user.status === 'deactivated'}
                <span class="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700">
                  Deactivated
                </span>
              {:else}
                <span class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
                  Active
                </span>
              {/if}
            </td>
            <td class="px-4 py-3">
              <ProjectsListCell projects={user.projects}>
                {#each user.projects as project (project.projectId)}
                  <li class="text-slate-700">{project.projectName}: {project.role}</li>
                {/each}
              </ProjectsListCell>
            </td>
          </tr>
        {/each}
      </DataTable>
    </div>

    <AccessReportPagination {asOf} {page} hasNext={report.hasNext} {data} />
  {/if}<InjectionPoint name="settings.audit-access-report.results" {data} />
</RegionFragment>
