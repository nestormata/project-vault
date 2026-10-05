<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { invalidateAll } from '$app/navigation'
  import { ApiClientError } from '$lib/api/client.js'
  import ProjectMembersHeader from '$lib/components/members/ProjectMembersHeader.svelte'
  import ProjectTeamPanel from '$lib/components/members/ProjectTeamPanel.svelte'
  import ProjectMembersNotice from '$lib/components/members/ProjectMembersNotice.svelte'
  import ProjectInviteRegion from '$lib/components/members/ProjectInviteRegion.svelte'
  import ProjectInvitationsTable from '$lib/components/members/ProjectInvitationsTable.svelte'
  import {
    createInvitation,
    revokeInvitation,
    type ProjectInvitation,
  } from '$lib/api/invitations.js'
  import {
    changeProjectRole,
    removeProjectMember,
    transferOwnership,
    type ProjectMember,
    type SettableProjectRole,
  } from '$lib/api/org-users.js'

  let { data } = $props()

  let showInviteForm = $state(false)
  let email = $state('')
  let role = $state<'admin' | 'member' | 'viewer'>('member')
  let errorMessage = $state<string | null>(null)
  let isSubmitting = $state(false)
  let revokingId = $state<string | null>(null)
  let memberBusyId = $state<string | null>(null)
  let memberError = $state<string | null>(null)
  let transferTarget = $state<string>('')

  // Story 69.4: the ungated region points get role/flag fields only (never member or invitation
  // rows); the gated ones add their own rows next to these.
  const baseProps = $derived({
    projectId: data.projectId,
    userId: data.userId,
    canManage: data.canManage,
    canManageMembers: data.canManageMembers,
    canTransferOwnership: data.canTransferOwnership,
  })

  async function onChangeMemberRole(member: ProjectMember, newRole: SettableProjectRole) {
    if (memberBusyId) return
    memberBusyId = member.userId
    memberError = null
    try {
      await changeProjectRole(fetch, member.userId, data.projectId, newRole)
      await invalidateAll()
    } catch (error) {
      memberError = error instanceof Error ? error.message : 'Failed to change role.'
    } finally {
      memberBusyId = null
    }
  }

  async function onRemoveMember(member: ProjectMember) {
    if (memberBusyId) return
    memberBusyId = member.userId
    memberError = null
    try {
      await removeProjectMember(fetch, data.projectId, member.userId)
      await invalidateAll()
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'last_owner') {
        memberError = 'Cannot remove the last owner — transfer ownership first.'
      } else {
        memberError = error instanceof Error ? error.message : 'Failed to remove member.'
      }
    } finally {
      memberBusyId = null
    }
  }

  async function onTransferOwnership() {
    if (memberBusyId || !transferTarget) return
    memberBusyId = transferTarget
    memberError = null
    try {
      await transferOwnership(fetch, data.projectId, transferTarget)
      transferTarget = ''
      await invalidateAll()
    } catch (error) {
      memberError = error instanceof Error ? error.message : 'Failed to transfer ownership.'
    } finally {
      memberBusyId = null
    }
  }

  async function submitInvite() {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    try {
      await createInvitation(fetch, data.projectId, { email, role })
      email = ''
      role = 'member'
      showInviteForm = false
      await invalidateAll()
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'mfa_required') {
        errorMessage = 'Enable MFA to invite teammates.'
      } else if (error instanceof ApiClientError && error.code === 'already_member') {
        errorMessage = 'That user is already a project member.'
      } else {
        errorMessage = error instanceof Error ? error.message : 'Failed to send invitation.'
      }
    } finally {
      isSubmitting = false
    }
  }

  async function onRevoke(invitation: ProjectInvitation) {
    if (revokingId) return
    revokingId = invitation.id
    try {
      await revokeInvitation(fetch, data.projectId, invitation.id)
      await invalidateAll()
    } finally {
      revokingId = null
    }
  }
</script>

<svelte:head>
  <title>Members | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.members.before" data={data?.__inject} />
<InjectionPoint name="project.members.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region project.members.header -->
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <ProjectMembersHeader
      canManage={data.canManage}
      {showInviteForm}
      onToggleInvite={() => (showInviteForm = !showInviteForm)}
    /><InjectionPoint name="project.members.header" props={baseProps} data={data?.__inject} />
  </div>

  {#if data.canManageMembers}
    <!-- @region project.members.access -->
    <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <ProjectTeamPanel
        members={data.members}
        {memberError}
        {memberBusyId}
        canTransferOwnership={data.canTransferOwnership}
        bind:transferTarget
        onChangeRole={onChangeMemberRole}
        onRemove={onRemoveMember}
        onTransfer={onTransferOwnership}
      /><InjectionPoint
        name="project.members.access"
        props={{ ...baseProps, members: data.members }}
        data={data?.__inject}
      />
    </div>
  {/if}

  {#if !data.canManage}
    <!-- @region project.members.notice -->
    <div class="rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <ProjectMembersNotice /><InjectionPoint
        name="project.members.notice"
        props={baseProps}
        data={data?.__inject}
      />
    </div>
  {:else}
    {#if showInviteForm}
      <!-- @region project.members.invite -->
      <ProjectInviteRegion
        bind:email
        bind:role
        {errorMessage}
        {isSubmitting}
        onsubmit={submitInvite}
      >
        <InjectionPoint name="project.members.invite" props={baseProps} data={data?.__inject} />
      </ProjectInviteRegion>
    {/if}

    <!-- @region project.members.invitations -->
    <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <ProjectInvitationsTable
        invitations={data.invitations}
        {revokingId}
        {onRevoke}
      /><InjectionPoint
        name="project.members.invitations"
        props={{ ...baseProps, invitations: data.invitations }}
        data={data?.__inject}
      />
    </div>
  {/if}
</section>
<InjectionPoint name="project.members.after" data={data?.__inject} />
