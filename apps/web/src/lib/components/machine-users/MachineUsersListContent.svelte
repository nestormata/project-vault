<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/machine-users/$types.js'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import DataTable from '$lib/components/tables/DataTable.svelte'

  let { data, canManage, children }: { data: PageData; canManage: boolean; children?: Snippet } =
    $props()

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
</script>

{@render children?.()}
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
            <span class="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">
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
