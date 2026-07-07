<script lang="ts">
  import { resolve } from '$app/paths'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import { canManageMachineUsers } from '$lib/machine-users/permissions.js'

  let { data } = $props()

  const canManage = $derived(canManageMachineUsers(data.orgRole))

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
</script>

<svelte:head>
  <title>Machine users | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Machine users</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">CI/CD service identities</h1>
      <p class="mt-2 text-slate-600">Manage machine users and their API keys for this project.</p>
      <a
        class="mt-3 inline-block text-sm font-medium text-slate-700 underline"
        href={resolve(`/projects/${data.projectId}/credentials`)}
      >
        Back to credentials
      </a>
    </div>
    {#if canManage}
      <a
        class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
        href={resolve(`/projects/${data.projectId}/machine-users/new`)}
      >
        Create machine user
      </a>
    {/if}
  </div>

  {#if data.notFound}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <p class="text-red-800">This project was not found or you do not have access.</p>
    </div>
  {:else if data.machineUsers.items.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <h2 class="text-xl font-semibold text-slate-950">No machine users yet</h2>
      <p class="mt-2 text-slate-600">
        {#if canManage}
          Create a machine user to issue an API key for CI/CD or other automated access.
        {:else}
          No machine users have been created in this project yet.
        {/if}
      </p>
    </div>
  {:else}
    <DataTable columns={['Name', 'Role', 'Keys', 'Created', 'Status']}>
      {#each data.machineUsers.items as machineUser (machineUser.id)}
        <tr class="border-b border-slate-100 last:border-b-0">
          <td class="px-4 py-3">
            <a
              class="font-semibold text-slate-950 underline"
              href={resolve(`/projects/${data.projectId}/machine-users/${machineUser.id}`)}
            >
              {machineUser.name}
            </a>
          </td>
          <td class="px-4 py-3 text-slate-600">{machineUser.role}</td>
          <td class="px-4 py-3 text-slate-600">{machineUser.keyCount}</td>
          <td class="px-4 py-3 text-slate-600">{formatDate(machineUser.createdAt)}</td>
          <td class="px-4 py-3">
            {#if machineUser.deactivatedAt}
              <span
                class="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700"
              >
                Deactivated
              </span>
            {:else}
              <span
                class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800"
              >
                Active
              </span>
            {/if}
          </td>
        </tr>
      {/each}
    </DataTable>
  {/if}
</section>
