<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { createErasureRequest, pseudonymizeUser } from '$lib/api/compliance.js'
  import DormancyThresholdOptions from '$lib/components/DormancyThresholdOptions.svelte'
  import RoleSelectOptions from '$lib/components/RoleSelectOptions.svelte'
  import TypedConfirmInput from '$lib/components/forms/TypedConfirmInput.svelte'
  import ProjectsListCell from '$lib/components/tables/ProjectsListCell.svelte'
  import {
    changeProjectRole,
    deactivateOrgUser,
    removeOrgUser,
    sendRecoveryLink,
    type OrgUser,
    type OrgUserProject,
    type SettableProjectRole,
  } from '$lib/api/org-users.js'
  import {
    updateMachineKeyDormancyThreshold,
    updateUserDormancyThreshold,
    type DormancyThresholdDays,
  } from '$lib/api/organization-settings.js'

  let { data } = $props()

  let errorMessage = $state<string | null>(null)
  let busyKey = $state<string | null>(null)

  // AC-4 — machine-key dormancy alert threshold. Deliberately a "set new value" control, not a
  // pre-populated one: the API only ships a PATCH for this setting (no GET), and this story is
  // scoped to add no new backend endpoint for AC-1–AC-4, so the current org value cannot be read
  // and displayed here without one. Defaulting the select to a real option would misleadingly
  // imply that's the current value, so it starts unselected instead.
  let dormancyThresholdChoice = $state<DormancyThresholdDays | ''>('')
  let dormancySaving = $state(false)
  let dormancySavedTo = $state<number | null>(null)
  let dormancyError = $state<string | null>(null)

  async function onSaveDormancyThreshold() {
    if (dormancySaving || dormancyThresholdChoice === '') return
    dormancySaving = true
    dormancyError = null
    dormancySavedTo = null
    try {
      const result = await updateMachineKeyDormancyThreshold(
        fetch,
        data.orgId,
        dormancyThresholdChoice
      )
      dormancySavedTo = result.machineKeyDormancyThresholdDays
    } catch (error) {
      dormancyError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to update dormancy threshold.')
          : 'Failed to update dormancy threshold.'
    } finally {
      dormancySaving = false
    }
  }
  // Story 8.7 AC-I1/I2/I3 — sibling "set a new value" control for the `user.dormant` alert
  // threshold, same D2 no-readback shape as the machine-key control above.
  let userDormancyThresholdChoice = $state<DormancyThresholdDays | ''>('')
  let userDormancySaving = $state(false)
  let userDormancySavedTo = $state<number | null>(null)
  let userDormancyError = $state<string | null>(null)

  async function onSaveUserDormancyThreshold() {
    if (userDormancySaving || userDormancyThresholdChoice === '') return
    userDormancySaving = true
    userDormancyError = null
    userDormancySavedTo = null
    try {
      const result = await updateUserDormancyThreshold(
        fetch,
        data.orgId,
        userDormancyThresholdChoice
      )
      userDormancySavedTo = result.userDormancyThresholdDays
    } catch (error) {
      userDormancyError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to update dormancy threshold.')
          : 'Failed to update dormancy threshold.'
    } finally {
      userDormancySaving = false
    }
  }

  // Story 8.7 AC group J — pseudonymize identity (owner-only, D4's typed-email confirmation).
  let pseudonymizeOpenFor = $state<string | null>(null)
  let pseudonymizeMatches = $state(false)
  let pseudonymizeSaving = $state(false)
  let pseudonymizeError = $state<string | null>(null)
  let pseudonymizeResults = $state<
    Record<string, { alias: string; otherAffectedOrgCount: number }>
  >({})

  function openPseudonymize(user: OrgUser) {
    pseudonymizeOpenFor = user.userId
    pseudonymizeMatches = false
    pseudonymizeError = null
  }

  async function onConfirmPseudonymize(user: OrgUser) {
    if (!pseudonymizeMatches || pseudonymizeSaving) return
    pseudonymizeSaving = true
    pseudonymizeError = null
    try {
      const result = await pseudonymizeUser(fetch, user.userId)
      // AC-J3 — Story 8.3 D8 makes a repeat call a true no-op returning the *existing* alias; this
      // client cannot distinguish that case from a fresh call using only the response fields
      // (both look identical), so the banner below always describes the alias/blast-radius the
      // server just returned rather than guessing whether this was the first call.
      pseudonymizeResults = {
        ...pseudonymizeResults,
        [user.userId]: { alias: result.alias, otherAffectedOrgCount: result.otherAffectedOrgCount },
      }
      pseudonymizeOpenFor = null
    } catch (error) {
      pseudonymizeError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to pseudonymize identity.')
          : 'Failed to pseudonymize identity.'
    } finally {
      pseudonymizeSaving = false
    }
  }

  // Story 8.7 AC group K — erasure request creation (admin+); on success/already-pending/
  // already-erased, navigates into the review/report flow at
  // /settings/users/[userId]/erasure/[requestId] (AC groups K/L/M own that page).
  let erasureOpenFor = $state<string | null>(null)
  let erasureReason = $state('')
  let erasureRequestedBy = $state('')
  let erasureSaving = $state(false)
  let erasureError = $state<string | null>(null)

  function openErasureRequest(user: OrgUser) {
    erasureOpenFor = user.userId
    erasureReason = ''
    erasureRequestedBy = ''
    erasureError = null
  }

  async function onSubmitErasureRequest(user: OrgUser) {
    if (erasureSaving) return
    erasureSaving = true
    erasureError = null
    try {
      const result = await createErasureRequest(fetch, user.userId, {
        reason: erasureReason,
        requestedBy: erasureRequestedBy,
      })
      await goto(resolve(`/settings/users/${user.userId}/erasure/${result.requestId}`))
    } catch (error) {
      // AC-K3/K4 — an already-pending or already-erased response is a legitimate "resume review"
      // / "view the completed report" outcome, not a failure: navigate into the existing
      // request's page using the requestId the error body carries, same as a fresh 201 would.
      if (error instanceof ApiClientError && (error.status === 409 || error.status === 410)) {
        const body = error.body as { requestId?: string } | null
        if (body?.requestId) {
          await goto(resolve(`/settings/users/${user.userId}/erasure/${body.requestId}`))
          return
        }
      }
      erasureError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to create erasure request.')
          : 'Failed to create erasure request.'
    } finally {
      erasureSaving = false
    }
  }

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

  async function onDeactivateOrgUser(user: OrgUser) {
    if (busyKey) return
    const confirmed = confirm(
      `Deactivate ${user.email}? ${user.email} will be signed out of every session immediately and can no longer log in. Pending invitations ${user.email} sent will be revoked.`
    )
    if (!confirmed) return
    busyKey = user.userId
    errorMessage = null
    try {
      await deactivateOrgUser(fetch, user.userId)
      await invalidateAll()
    } catch (error) {
      errorMessage =
        error instanceof ApiClientError && error.code === 'already_deactivated'
          ? `${user.email} is already deactivated.`
          : error instanceof ApiClientError
            ? (error.message ?? 'Failed to deactivate account.')
            : 'Failed to deactivate account.'
    } finally {
      busyKey = null
    }
  }

  let recoveryLinkSentFor = $state<string | null>(null)

  async function onSendRecoveryLink(user: OrgUser) {
    if (busyKey) return
    const confirmed = confirm(`Send ${user.email} a password recovery link?`)
    if (!confirmed) return
    busyKey = user.userId
    errorMessage = null
    recoveryLinkSentFor = null
    try {
      await sendRecoveryLink(fetch, user.userId)
      recoveryLinkSentFor = user.userId
    } catch (error) {
      errorMessage =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to send recovery link.')
          : 'Failed to send recovery link.'
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
    <div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Machine key dormancy alerts</h2>
      <p class="mt-2 text-sm text-slate-600">
        How long a machine-user API key can go unused before a dormancy alert fires (Security Alerts
        / Notifications inbox).
      </p>
      <p class="mt-2 text-sm font-medium text-amber-800">
        Changing this is not retroactive: alerts already fired under the old threshold are not
        reconciled or auto-dismissed when you change this setting.
      </p>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <label class="sr-only" for="dormancy-threshold-select">Dormancy threshold (days)</label>
        <select
          id="dormancy-threshold-select"
          class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          bind:value={dormancyThresholdChoice}
        >
          <DormancyThresholdOptions />
        </select>
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          type="button"
          disabled={dormancySaving || dormancyThresholdChoice === ''}
          onclick={() => void onSaveDormancyThreshold()}
        >
          {dormancySaving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {#if dormancySavedTo !== null}
        <p class="mt-2 text-sm text-emerald-700">
          Threshold updated to {dormancySavedTo} days.
        </p>
      {/if}
      {#if dormancyError}
        <p class="mt-2 text-sm text-red-700" role="alert">{dormancyError}</p>
      {/if}
    </div>

    <div class="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">User dormancy alerts</h2>
      <p class="mt-2 text-sm text-slate-600">
        How long a user account can go without activity before a dormancy alert fires (Security
        Alerts / Notifications inbox).
      </p>
      <p class="mt-2 text-sm font-medium text-amber-800">
        Changing this threshold does not affect alerts already in your Dormant user alerts inbox.
      </p>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <label class="sr-only" for="user-dormancy-threshold-select">
          User dormancy threshold (days)
        </label>
        <select
          id="user-dormancy-threshold-select"
          class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          bind:value={userDormancyThresholdChoice}
        >
          <DormancyThresholdOptions />
        </select>
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          type="button"
          disabled={userDormancySaving || userDormancyThresholdChoice === ''}
          onclick={() => void onSaveUserDormancyThreshold()}
        >
          {userDormancySaving ? 'Saving…' : 'Save user dormancy threshold'}
        </button>
      </div>
      {#if userDormancySavedTo !== null}
        <p class="mt-2 text-sm text-emerald-700">
          Threshold updated to {userDormancySavedTo} days.
        </p>
      {/if}
      {#if userDormancyError}
        <p class="mt-2 text-sm text-red-700" role="alert">{userDormancyError}</p>
      {/if}
    </div>

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
              <td class="px-4 py-3 font-medium text-slate-900">
                {user.displayName}
                {#if user.status === 'deactivated'}
                  <span
                    class="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700"
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
                </ProjectsListCell>
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex flex-col items-end gap-1">
                  {#if user.status === 'active'}
                    <button
                      class="text-sm font-medium text-amber-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      disabled={busyKey === user.userId}
                      onclick={() => onDeactivateOrgUser(user)}
                    >
                      Deactivate account
                    </button>
                  {/if}
                  <button
                    class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                    type="button"
                    disabled={busyKey === user.userId}
                    onclick={() => onSendRecoveryLink(user)}
                  >
                    Send recovery link
                  </button>
                  {#if recoveryLinkSentFor === user.userId}
                    <p class="text-xs text-slate-600">Recovery link sent.</p>
                  {/if}
                  <button
                    class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                    type="button"
                    disabled={busyKey === user.userId}
                    onclick={() => onRemoveOrgUser(user)}
                  >
                    Remove from organization
                  </button>
                  {#if blockedRemoval[user.userId]}
                    <p class="text-xs text-amber-800" role="alert">
                      {blockedRemoval[user.userId]}
                    </p>
                  {/if}

                  <!-- Story 8.7 AC-A4/K: admin+ can request erasure -->
                  {#if data.orgRole === 'owner' || data.orgRole === 'admin'}
                    <button
                      class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      onclick={() => openErasureRequest(user)}
                    >
                      Request erasure
                    </button>
                  {/if}

                  <!-- Story 8.7 AC-A4/J: owner-only pseudonymize -->
                  {#if data.orgRole === 'owner'}
                    <button
                      class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      onclick={() => openPseudonymize(user)}
                    >
                      Pseudonymize identity
                    </button>
                  {/if}

                  {#if pseudonymizeResults[user.userId]}
                    <p class="max-w-xs text-left text-xs text-emerald-700">
                      Identity pseudonymized as {pseudonymizeResults[user.userId]?.alias}.
                      {pseudonymizeResults[user.userId]?.otherAffectedOrgCount === 0
                        ? 'No other organizations affected.'
                        : `This also affects how this user's audit history displays in ${pseudonymizeResults[user.userId]?.otherAffectedOrgCount} other organization(s) they belong to.`}
                    </p>
                  {/if}

                  {#if pseudonymizeOpenFor === user.userId}
                    <div
                      class="mt-2 w-64 rounded-lg border border-red-200 bg-red-50 p-3 text-left text-xs"
                    >
                      <p class="font-semibold text-red-800">
                        This action is permanent and irreversible.
                      </p>
                      <p class="mt-1 text-slate-700">
                        This may also affect how this user's audit history displays in other
                        organizations they belong to — you'll see the exact count after confirming.
                      </p>
                      <div class="mt-2">
                        <TypedConfirmInput
                          expectedValue={user.email}
                          label={`Type the exact email to confirm (${user.email})`}
                          inputId={`pseudonymize-confirm-${user.userId}`}
                          onMatchChange={(matches) => (pseudonymizeMatches = matches)}
                        />
                      </div>
                      <div class="mt-2 flex gap-2">
                        <button
                          type="button"
                          class="rounded-lg border border-red-400 px-2 py-1 text-xs font-semibold text-red-800 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={!pseudonymizeMatches || pseudonymizeSaving}
                          onclick={() => onConfirmPseudonymize(user)}
                        >
                          {pseudonymizeSaving ? 'Pseudonymizing…' : 'Confirm pseudonymize'}
                        </button>
                        <button
                          type="button"
                          class="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700"
                          onclick={() => (pseudonymizeOpenFor = null)}
                        >
                          Cancel
                        </button>
                      </div>
                      {#if pseudonymizeError}
                        <p class="mt-1 text-red-700" role="alert">{pseudonymizeError}</p>
                      {/if}
                    </div>
                  {/if}

                  {#if erasureOpenFor === user.userId}
                    <div
                      class="mt-2 w-64 rounded-lg border border-slate-200 bg-slate-50 p-3 text-left text-xs"
                    >
                      <label class="flex flex-col gap-1" for={`erasure-reason-${user.userId}`}>
                        Reason
                        <textarea
                          id={`erasure-reason-${user.userId}`}
                          class="rounded border border-slate-300 px-2 py-1"
                          maxlength="2000"
                          bind:value={erasureReason}></textarea>
                      </label>
                      <label
                        class="mt-2 flex flex-col gap-1"
                        for={`erasure-requestedBy-${user.userId}`}
                      >
                        Requested by
                        <input
                          id={`erasure-requestedBy-${user.userId}`}
                          type="text"
                          class="rounded border border-slate-300 px-2 py-1"
                          maxlength="500"
                          bind:value={erasureRequestedBy}
                        />
                      </label>
                      <div class="mt-2 flex gap-2">
                        <button
                          type="button"
                          class="rounded-lg border border-slate-400 px-2 py-1 text-xs font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={erasureSaving ||
                            !erasureReason.trim() ||
                            !erasureRequestedBy.trim()}
                          onclick={() => onSubmitErasureRequest(user)}
                        >
                          {erasureSaving ? 'Submitting…' : 'Submit request'}
                        </button>
                        <button
                          type="button"
                          class="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700"
                          onclick={() => (erasureOpenFor = null)}
                        >
                          Cancel
                        </button>
                      </div>
                      {#if erasureError}
                        <p class="mt-1 text-red-700" role="alert">{erasureError}</p>
                      {/if}
                    </div>
                  {/if}
                </div>
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
