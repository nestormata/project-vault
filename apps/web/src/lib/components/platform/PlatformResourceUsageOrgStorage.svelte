<script lang="ts">
  import type { ResourceUsageResponse } from '$lib/api/platform.js'
  import type { AuditQuotaEditor } from './audit-quota-editor.svelte.js'
  import PlatformResourceUsageAllocation from './PlatformResourceUsageAllocation.svelte'
  import PlatformResourceUsageOrgTable from './PlatformResourceUsageOrgTable.svelte'

  // Story 22.3 AC-5/AC-6/AC-7, Story 69.14: the per-organization audit-storage card is a container
  // around two sub-regions (the allocation summary with its notices, the table) and a footnote.
  let {
    usage,
    editor,
    data,
  }: {
    usage: ResourceUsageResponse
    editor: AuditQuotaEditor
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-base font-semibold text-gray-900">Audit Storage by Organization</h2>

  <PlatformResourceUsageAllocation {usage} {editor} {data} />

  <PlatformResourceUsageOrgTable {editor} {data} />

  <p class="mt-3 text-xs text-gray-500">
    Per-organization figures count row data only (logical bytes); the instance total above includes
    indexes, padding and storage overhead (physical bytes) and does not equal the sum of the rows
    below.
  </p>
</section>
