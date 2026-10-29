<script lang="ts">
  import type { OrgUser, OrgUserProject, SettableProjectRole } from '$lib/api/org-users.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import RoleSelectOptions from '$lib/components/RoleSelectOptions.svelte'
  import ProjectsListCell from '$lib/components/tables/ProjectsListCell.svelte'
  import UsersDangerZone from './UsersDangerZone.svelte'
  import UsersErasureForm from './UsersErasureForm.svelte'
  import UsersPseudonymize from './UsersPseudonymize.svelte'
  import type { UsersActions } from './users-actions.svelte.js'

  // Story 69.10: one row of the users table. The table's `actions` owns the state shared by the rows
  // (one busy key, one open panel at a time); the row sections render and drive it.
  let {
    actions,
    user,
    orgRole,
    nativeLoginEnabled,
  }: {
    actions: UsersActions
    user: OrgUser
    orgRole: string
    nativeLoginEnabled: boolean
  } = $props()
</script>

<tr class="border-b border-slate-100 align-top last:border-b-0">
  <td class="px-4 py-3 font-medium text-slate-900">
    {user.displayName}
    {#if user.status === 'deactivated'}
      <span class="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700"
        >Deactivated</span
      >
    {/if}
  </td>
  <td class="px-4 py-3 text-slate-600">{user.orgRole}</td>
  <td class="px-4 py-3">
    <ProjectsListCell projects={user.projects}>
      {#each user.projects as project (project.projectId)}
        <li class="flex items-center gap-2">
          <span class="text-slate-700">{project.projectName}:</span>
          {#if project.role === 'owner'}
            <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">owner</span>
          {:else}
            <select
              class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs"
              aria-label={`Role for ${user.email} in ${project.projectName}`}
              aria-describedby={`user-project-role-help-${user.userId}-${project.projectId}`}
              value={project.role}
              disabled={actions.busyKey === `${user.userId}:${project.projectId}`}
              onchange={(event) =>
                actions.onChangeRole(
                  user,
                  project,
                  (event.currentTarget as HTMLSelectElement).value as SettableProjectRole
                )}
            >
              <RoleSelectOptions />
            </select>
            <FormHelpText
              id={`user-project-role-help-${user.userId}-${project.projectId}`}
              kind="select"
            />
          {/if}
        </li>
      {/each}
    </ProjectsListCell>
  </td>
  <td class="px-4 py-3 text-right">
    <div class="flex flex-col items-end gap-1">
      {#if nativeLoginEnabled}
        <button
          class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          disabled={actions.busyKey === user.userId}
          onclick={() => actions.onSendRecoveryLink(user)}
        >
          Send recovery link
        </button>
        {#if actions.recoveryLinkSentFor === user.userId}
          <p class="text-xs text-slate-600">Recovery link sent.</p>
        {/if}
      {:else}
        <!-- Story 23.2 AC-6 row #10 / G3: this action 403s (native_login_disabled)
             once native login is excluded -- honest disabled state, never a live
             button that fails on click. -->
        <span
          class="text-xs text-slate-500"
          title="Native login is disabled on this vault; recovery links cannot be sent."
        >
          Recovery link unavailable (external sign-in)
        </span>
      {/if}
      <UsersDangerZone {actions} {user} {orgRole} />
      <UsersPseudonymize {actions} {user} {orgRole} />
      <UsersErasureForm {actions} {user} />
    </div>
  </td>
</tr>
