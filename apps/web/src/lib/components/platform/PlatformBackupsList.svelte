<script lang="ts">
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { BackupsController } from './backups-controller.svelte.js'
  import PlatformBackupRow from './PlatformBackupRow.svelte'

  // Story 69.14: the backups table (or its empty state) as one replaceable region; each row brings
  // its own validate result and restore panel.
  let {
    controller,
    pageError,
    data,
  }: {
    controller: BackupsController
    pageError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.backups.list -->
<div class="mt-6">
  {#if controller.backups.length === 0 && !pageError}
    <p class="rounded-lg border border-gray-200 bg-white px-6 py-8 text-center text-gray-500">
      No backups yet.
    </p>
  {:else}
    <DataTable
      columns={['Filename', 'Started', 'Status', 'Size', 'Verified', 'Key Version', 'Actions']}
    >
      {#each controller.backups as backup (backup.filename)}
        <PlatformBackupRow {backup} {controller} />
      {/each}
    </DataTable>
  {/if}<InjectionPoint name="platform.backups.list" {data} />
</div>
