<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import type { ProjectMember, SettableProjectRole } from '$lib/api/org-users.js'
  import ProjectTeamMembersTable from './ProjectTeamMembersTable.svelte'

  // Story 69.11: the member table of the "Team members" card as one replaceable region.
  let {
    members,
    memberBusyId,
    onChangeRole,
    onRemove,
    pointProps,
    data,
  }: {
    members: readonly ProjectMember[]
    memberBusyId: string | null
    onChangeRole: (member: ProjectMember, role: SettableProjectRole) => void
    onRemove: (member: ProjectMember) => void
    pointProps: InjectionPointExtras<'project.members.header'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.members.team-table -->
<div class="overflow-hidden rounded-2xl border border-slate-200">
  <ProjectTeamMembersTable {members} {memberBusyId} {onChangeRole} {onRemove} /><InjectionPoint
    name="project.members.team-table"
    props={pointProps}
    {data}
  />
</div>
