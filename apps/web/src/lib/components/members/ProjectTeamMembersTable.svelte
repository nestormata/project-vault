<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import RoleSelectOptions from '$lib/components/RoleSelectOptions.svelte'
  import type { ProjectMember, SettableProjectRole } from '$lib/api/org-users.js'

  // Story 69.11: the rows of the member table (role select and removal per row).
  let {
    members,
    memberBusyId,
    onChangeRole,
    onRemove,
  }: {
    members: readonly ProjectMember[]
    memberBusyId: string | null
    onChangeRole: (member: ProjectMember, role: SettableProjectRole) => void
    onRemove: (member: ProjectMember) => void
  } = $props()
</script>

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
            <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">owner</span>
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
