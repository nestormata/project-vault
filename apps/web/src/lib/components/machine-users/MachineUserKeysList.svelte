<script lang="ts">
  import type { ApiKeyMetadata } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { PointData } from './machine-user-detail.js'
  import type { MachineUserKeys } from './machine-user-keys.svelte.js'
  import MachineUserKeyRow from './MachineUserKeyRow.svelte'

  // Story 69.14: the API key list of a machine user as one replaceable region. Row actions run in
  // the keys controller owned by the detail content and report their error here.
  let {
    items,
    canManage,
    keys,
    data,
  }: {
    items: readonly ApiKeyMetadata[]
    canManage: boolean
    keys: MachineUserKeys
    data?: PointData
  } = $props()
</script>

<!-- @region project.machine-users-detail.keys -->
<RegionFragment>
  <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-950">API keys</h2>
    {#if keys.actionError}
      <p class="mt-2 text-sm text-red-700" role="alert">{keys.actionError}</p>
    {/if}
    {#if items.length === 0}
      <p class="mt-3 text-sm text-slate-600">No API keys have been issued yet.</p>
    {:else}
      <ul class="mt-4 space-y-3">
        {#each items as apiKey (apiKey.id)}
          <MachineUserKeyRow {apiKey} {canManage} {keys} />
        {/each}
      </ul>
    {/if}<InjectionPoint name="project.machine-users-detail.keys" {data} />
  </section>
</RegionFragment>
