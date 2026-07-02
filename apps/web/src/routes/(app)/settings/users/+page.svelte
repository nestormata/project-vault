<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { ApiClientError } from '$lib/api/client.js'
  import RoleSelectOptions from '$lib/components/RoleSelectOptions.svelte'
  import {
    changeProjectRole,
    removeOrgUser,
    type OrgUser,
    type OrgUserProject,
    type SettableProjectRole,
  } from '$lib/api/org-users.js'

  let { data } = $props()

  let errorMessage = $state<string | null>(null)
  let busyKey = $state<string | null>(null)
  // Maps a userId to a human-readable "sole owner of these projects" blocking message.
  let blockedRemoval = $state<Record<string, string>>({})

  function soleOwnerMessage(email: string, projects: { projectName: string }[]): string {
    const names = projects.map((p) => p.projectName).join(', ')
    const count = projects.length
    return `${email} owns ${count} project${count === 1 ? '' : 's'} (${names}) — transfer ownership before removing`
  }

  async function onChangeRole(user: OrgUser, project: OrgUserProject, role: SettableProjectRole) {
    const key = `${user.userId}:${project.projectId}`
    if (busyKey) return
    busyKey = key
    errorMessage = null
    try {
      await changeProjectRole(fetch, user.userId, project.projectId, role)
      await invalidateAll()
    } catch (error) {
      errorMessage =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to change role.')
          : 'Failed to change role.'
    } finally {
      busyKey = null
    }
  }

  async function onRemoveOrgUser(user: OrgUser) {
    if (busyKey) return
    const confirmed = confirm(
      `Remove ${user.email} from the organization? This removes them from every project and signs out their sessions immediately.`
    )
    if (!confirmed) return
    busyKey = user.userId
    errorMessage = null
    delete blockedRemoval[user.userId]
    try {
      await removeOrgUser(fetch, user.userId)
      await invalidateAll()
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'sole_owner_of_projects') {
        const projects =
          (error.body as { projects?: { projectName: string }[] } | null)?.projects ?? []
        blockedRemoval = {
          ...blockedRemoval,
          [user.userId]: soleOwnerMessage(user.email, projects),
        }
      } else if (error instanceof ApiClientError && error.code === 'last_org_owner') {
        blockedRemoval = {
          ...blockedRemoval,
          [user.userId]: 'Cannot remove the sole owner of the organization.',
        }
      } else {
        errorMessage =
          error instanceof ApiClientError
            ? (error.message ?? 'Failed to remove user.')
            : 'Failed to remove user.'
      }
    } finally {
      busyKey = null
    }
  }
</script>

<svelte:head>
  <title>Users | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Users</h1>
  <p class="mt-2 text-gray-500">
    Manage everyone across your organization and their project roles.
  </p>

  {#if !data.canManage}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">Only organization owners and admins can manage users.</p>
    </div>
  {:else}
    {#if errorMessage}
      <p
        class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        role="alert"
      >
        {errorMessage}
      </p>
    {/if}

    <div class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table class="min-w-full text-left text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
          <tr>
            <th class="px-4 py-3 font-semibold">User</th>
            <th class="px-4 py-3 font-semibold">Org role</th>
            <th class="px-4 py-3 font-semibold">Projects</th>
            <th class="px-4 py-3 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {#each data.users as user (user.userId)}
            <tr class="border-b border-slate-100 align-top last:border-b-0">
              <td class="px-4 py-3 font-medium text-slate-900">{user.displayName}</td>
              <td class="px-4 py-3 text-slate-600">{user.orgRole}</td>
              <td class="px-4 py-3">
                {#if user.projects.length === 0}
                  <span class="text-slate-400">No project memberships</span>
                {:else}
                  <ul class="space-y-1">
                    {#each user.projects as project (project.projectId)}
                      <li class="flex items-center gap-2">
                        <span class="text-slate-700">{project.projectName}:</span>
                        {#if project.role === 'owner'}
                          <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                            >owner</span
                          >
                        {:else}
                          <select
                            class="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                            aria-label={`Role for ${user.email} in ${project.projectName}`}
                            value={project.role}
                            disabled={busyKey === `${user.userId}:${project.projectId}`}
                            onchange={(event) =>
                              onChangeRole(
                                user,
                                project,
                                (event.currentTarget as HTMLSelectElement)
                                  .value as SettableProjectRole
                              )}
                          >
                            <RoleSelectOptions />
                          </select>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </td>
              <td class="px-4 py-3 text-right">
                <button
                  class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                  type="button"
                  disabled={busyKey === user.userId}
                  onclick={() => onRemoveOrgUser(user)}
                >
                  Remove from organization
                </button>
                {#if blockedRemoval[user.userId]}
                  <p class="mt-1 text-xs text-amber-800" role="alert">
                    {blockedRemoval[user.userId]}
                  </p>
                {/if}
              </td>
            </tr>
          {:else}
            <tr>
              <td class="px-4 py-6 text-center text-slate-600" colspan="4">No users found.</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
