<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import RoleSelectOptions from '$lib/components/RoleSelectOptions.svelte'
  import type { ProjectMember, SettableProjectRole } from '$lib/api/org-users.js'

  // Story 69.4: the body of the "Team members" card (heading, error, member table and the transfer
  // ownership row). The page owns the data, the busy flags and the mutations and passes them in; it
  // keeps the card element (inside its `canManageMembers` gate) and renders its
  // `project.members.access` point after this.
  let {
    members,
    memberError,
    memberBusyId,
    canTransferOwnership,
    transferTarget = $bindable(),
    onChangeRole,
    onRemove,
    onTransfer,
  }: {
    members: readonly ProjectMember[]
    memberError: string | null
    memberBusyId: string | null
    canTransferOwnership: boolean
    transferTarget: string
    onChangeRole: (member: ProjectMember, role: SettableProjectRole) => void
    onRemove: (member: ProjectMember) => void
    onTransfer: () => void
  } = $props()

  const nonOwnerMembers = $derived(members.filter((m) => m.role !== 'owner'))
</script>

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
      {#each members as member (member.userId)}
        <tr class="border-b border-slate-100 last:border-b-0">
          <td class="px-4 py-3">{member.displayName}</td>
          <td class="px-4 py-3">
            {#if member.role === 'owner'}
              <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">owner</span
              >
            {:else}
              <select
                class="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                aria-label={`Role for ${member.email}`}
                aria-describedby={`member-role-help-${member.userId}`}
                value={member.role}
                disabled={memberBusyId === member.userId}
                onchange={(event) =>
                  onChangeRole(
                    member,
                    (event.currentTarget as HTMLSelectElement).value as SettableProjectRole
                  )}
              >
                <RoleSelectOptions />
              </select>
              <FormHelpText id={`member-role-help-${member.userId}`} kind="select" />
            {/if}
          </td>
          <td class="px-4 py-3 text-right">
            {#if member.role !== 'owner'}
              <button
                class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                disabled={memberBusyId === member.userId}
                onclick={() => onRemove(member)}
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

{#if canTransferOwnership && nonOwnerMembers.length > 0}
  <div class="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
    <label class="font-medium text-slate-900" for="transfer-owner">Transfer ownership</label>
    <select
      id="transfer-owner"
      class="rounded-lg border border-slate-300 px-2 py-1 text-sm"
      bind:value={transferTarget}
      aria-describedby="transfer-owner-help"
    >
      <option value="">Select a member…</option>
      {#each nonOwnerMembers as member (member.userId)}
        <option value={member.userId}>{member.email}</option>
      {/each}
    </select>
    <FormHelpText id="transfer-owner-help" kind="select" />
    <button
      class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      disabled={!transferTarget || memberBusyId !== null}
      onclick={() => onTransfer()}
    >
      Transfer
    </button>
  </div>
{/if}
