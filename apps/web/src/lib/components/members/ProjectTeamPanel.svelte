<script lang="ts">
  import type { ProjectMember, SettableProjectRole } from '$lib/api/org-users.js'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import ProjectTeamError from './ProjectTeamError.svelte'
  import ProjectTeamTable from './ProjectTeamTable.svelte'
  import ProjectTeamTransfer from './ProjectTeamTransfer.svelte'

  // Story 69.4: the body of the "Team members" card (heading, error, member table and the transfer
  // ownership row). The page owns the data, the busy flags and the mutations and passes them in; it
  // keeps the card element (inside its `canManageMembers` gate) and renders its
  // `project.members.access` point after this.
  // Story 69.11: the error banner, the table and the transfer row are sub-regions of the card.
  let {
    members,
    memberError,
    memberBusyId,
    canTransferOwnership,
    transferTarget = $bindable(),
    onChangeRole,
    onRemove,
    onTransfer,
    pointProps,
    data,
  }: {
    members: readonly ProjectMember[]
    memberError: string | null
    memberBusyId: string | null
    canTransferOwnership: boolean
    transferTarget: string
    onChangeRole: (member: ProjectMember, role: SettableProjectRole) => void
    onRemove: (member: ProjectMember) => void
    onTransfer: () => void
    pointProps: InjectionPointExtras<'project.members.header'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const nonOwnerMembers = $derived(members.filter((m) => m.role !== 'owner'))
</script>

<div class="flex items-center justify-between">
  <h2 class="text-xl font-semibold text-slate-950">Team members</h2>
</div>
<ProjectTeamError {memberError} {pointProps} {data} />
<ProjectTeamTable {members} {memberBusyId} {onChangeRole} {onRemove} {pointProps} {data} />

{#if canTransferOwnership && nonOwnerMembers.length > 0}
  <ProjectTeamTransfer
    {nonOwnerMembers}
    {memberBusyId}
    bind:transferTarget
    {onTransfer}
    {pointProps}
    {data}
  />
{/if}
