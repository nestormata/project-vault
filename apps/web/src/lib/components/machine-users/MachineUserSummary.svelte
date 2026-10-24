<script lang="ts">
  import type { MachineUserDetail } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import MachineUserDeactivate from './MachineUserDeactivate.svelte'
  import { formatDate, type PointData } from './machine-user-detail.js'

  // Story 69.14: the identity card of a machine user (status, name, role, scope boundary) as one
  // replaceable region, with the deactivate control as the last section of the card.
  let {
    machineUser,
    machineUserId,
    isDeactivated,
    canManage,
    data,
  }: {
    machineUser: MachineUserDetail
    machineUserId: string
    isDeactivated: boolean
    canManage: boolean
    data?: PointData
  } = $props()
</script>

<!-- @region project.machine-users-detail.summary -->
<RegionFragment>
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="flex flex-wrap items-center gap-3">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Machine user</p>
      {#if isDeactivated}
        <span class="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">
          Deactivated
        </span>
      {:else}
        <span class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
          Active
        </span>
      {/if}
    </div>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">{machineUser.name}</h1>
    {#if machineUser.description}
      <p class="mt-2 text-slate-600">{machineUser.description}</p>
    {/if}
    <dl class="mt-5 grid gap-3 sm:grid-cols-2">
      <div class="rounded-2xl bg-slate-50 p-4">
        <dt class="text-sm text-slate-500">Role</dt>
        <dd class="font-medium text-slate-950">{machineUser.role}</dd>
      </div>
      <div class="rounded-2xl bg-slate-50 p-4">
        <dt class="text-sm text-slate-500">Created</dt>
        <dd class="font-medium text-slate-950">{formatDate(machineUser.createdAt)}</dd>
      </div>
    </dl>

    <div class="mt-5 rounded-2xl bg-slate-50 p-4">
      <p class="text-sm font-semibold text-slate-900">Scope boundary</p>
      <div class="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <p class="text-xs font-semibold uppercase text-slate-500">Can access</p>
          <ul class="mt-1 list-inside list-disc text-sm text-slate-700">
            {#each machineUser.scopeBoundary.canAccess as item (item)}
              <li>{item}</li>
            {/each}
          </ul>
        </div>
        <div>
          <p class="text-xs font-semibold uppercase text-slate-500">Cannot access</p>
          <ul class="mt-1 list-inside list-disc text-sm text-slate-700">
            {#each machineUser.scopeBoundary.cannotAccess as item (item)}
              <li>{item}</li>
            {/each}
          </ul>
        </div>
      </div>
    </div>

    <InjectionPoint name="project.machine-users-detail.summary" {data} /><MachineUserDeactivate
      {machineUserId}
      show={canManage && !isDeactivated}
      {data}
    />
  </div>
</RegionFragment>
