<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import type { AuditQuotaEditor } from './audit-quota-editor.svelte.js'
  import PlatformAuditOrgRow from './PlatformAuditOrgRow.svelte'

  // Story 22.3 AC-5, Story 69.14: the per-organization audit-storage table (or its empty state) as
  // one replaceable region; each row brings its own inline quota form.
  let {
    editor,
    data,
  }: {
    editor: AuditQuotaEditor
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.org-table -->
<div class="mt-4">
  {#if editor.rows.length === 0}
    <p class="rounded-lg border border-gray-200 bg-white px-6 py-8 text-center text-gray-500">
      No organizations yet.
    </p>
  {:else}
    <DataTable
      columns={['Organization', 'Used', 'Quota', 'Utilization', 'Write Rate', 'State', 'Actions']}
    >
      {#each editor.rows as row (row.orgId)}
        <PlatformAuditOrgRow {row} {editor} />
      {/each}
    </DataTable>
  {/if}<InjectionPoint name="platform.settings-resource-usage.org-table" {data} />
</div>
