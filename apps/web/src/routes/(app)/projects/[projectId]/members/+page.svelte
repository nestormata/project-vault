<script lang="ts">
  import { resolve } from '$app/paths'
  import { invalidateAll } from '$app/navigation'
  import { ApiClientError } from '$lib/api/client.js'
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

  const nonOwnerMembers = $derived(data.members.filter((m) => m.role !== 'owner'))

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

  function relativeExpiry(expiresAt: string): string {
    const ms = new Date(expiresAt).getTime() - Date.now()
    if (ms <= 0) return 'expired'
    const hours = Math.round(ms / (60 * 60 * 1000))
    if (hours < 24) return `expires in ${hours}h`
    return `expires in ${Math.round(hours / 24)}d`
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

<section class="space-y-6">
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Members</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">Project members</h1>
      <p class="mt-2 text-slate-600">Invite teammates and manage pending invitations.</p>
    </div>
    {#if data.canManage}
      <button
        class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
        type="button"
        onclick={() => (showInviteForm = !showInviteForm)}
      >
        {showInviteForm ? 'Cancel' : 'Invite member'}
      </button>
    {/if}
  </div>

  {#if data.canManageMembers}
    <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold text-slate-950">Team members</h2>
      </div>
      {#if memberError}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {memberError}
        </p>
      {/if}
      <div class="overflow-hidden rounded-2xl border border-slate-200">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th class="px-4 py-3 font-semibold">Email</th>
              <th class="px-4 py-3 font-semibold">Role</th>
              <th class="px-4 py-3 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {#each data.members as member (member.userId)}
              <tr class="border-b border-slate-100 last:border-b-0">
                <td class="px-4 py-3">{member.displayName}</td>
                <td class="px-4 py-3">
                  {#if member.role === 'owner'}
                    <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                      >owner</span
                    >
                  {:else}
                    <select
                      class="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                      aria-label={`Role for ${member.email}`}
                      value={member.role}
                      disabled={memberBusyId === member.userId}
                      onchange={(event) =>
                        onChangeMemberRole(
                          member,
                          (event.currentTarget as HTMLSelectElement).value as SettableProjectRole
                        )}
                    >
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                      <option value="viewer">viewer</option>
                    </select>
                  {/if}
                </td>
                <td class="px-4 py-3 text-right">
                  {#if member.role !== 'owner'}
                    <button
                      class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      disabled={memberBusyId === member.userId}
                      onclick={() => onRemoveMember(member)}
                    >
                      Remove
                    </button>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr>
                <td class="px-4 py-6 text-center text-slate-600" colspan="3">No members yet.</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if data.canTransferOwnership && nonOwnerMembers.length > 0}
        <div class="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <label class="font-medium text-slate-900" for="transfer-owner">Transfer ownership</label>
          <select
            id="transfer-owner"
            class="rounded-lg border border-slate-300 px-2 py-1 text-sm"
            bind:value={transferTarget}
          >
            <option value="">Select a member…</option>
            {#each nonOwnerMembers as member (member.userId)}
              <option value={member.userId}>{member.email}</option>
            {/each}
          </select>
          <button
            class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            disabled={!transferTarget || memberBusyId !== null}
            onclick={() => onTransferOwnership()}
          >
            Transfer
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#if !data.canManage}
    <div class="rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">Only project owners and admins can manage invitations.</p>
    </div>
  {:else}
    {#if showInviteForm}
      <form
        class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        onsubmit={(event) => {
          event.preventDefault()
          void submitInvite()
        }}
      >
        <div class="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <div class="space-y-2">
            <label class="block font-medium text-slate-900" for="invite-email">Email</label>
            <input
              id="invite-email"
              class="w-full rounded-xl border border-slate-300 px-3 py-2"
              type="email"
              bind:value={email}
              required
            />
          </div>
          <div class="space-y-2">
            <label class="block font-medium text-slate-900" for="invite-role">Role</label>
            <select
              id="invite-role"
              class="w-full rounded-xl border border-slate-300 px-3 py-2"
              bind:value={role}
            >
              <option value="admin">Admin</option>
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
        </div>
        {#if errorMessage}
          <p
            class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            role="alert"
          >
            {errorMessage}
            {#if errorMessage.includes('MFA')}
              <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
            {/if}
          </p>
        {/if}
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Sending...' : 'Send invite'}
        </button>
      </form>
    {/if}

    <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table class="min-w-full text-left text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
          <tr>
            <th class="px-4 py-3 font-semibold">Email</th>
            <th class="px-4 py-3 font-semibold">Role</th>
            <th class="px-4 py-3 font-semibold">Expiry</th>
            <th class="px-4 py-3 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {#each data.invitations as invitation (invitation.id)}
            <tr class="border-b border-slate-100 last:border-b-0">
              <td class="px-4 py-3">{invitation.email}</td>
              <td class="px-4 py-3 text-slate-600">{invitation.roleToAssign}</td>
              <td class="px-4 py-3 text-slate-600">{relativeExpiry(invitation.expiresAt)}</td>
              <td class="px-4 py-3 text-right">
                <button
                  class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                  type="button"
                  disabled={revokingId === invitation.id}
                  onclick={() => onRevoke(invitation)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          {:else}
            <tr>
              <td class="px-4 py-6 text-center text-slate-600" colspan="4">
                No pending invitations.
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
