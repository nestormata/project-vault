<script lang="ts">
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import { AuditExportController } from './audit-export-controller.svelte.js'
  import AuditExportForm from './AuditExportForm.svelte'
  import AuditExportResult from './AuditExportResult.svelte'
  import AuditExportStatus from './AuditExportStatus.svelte'

  // Story 69.12: the export card is the heading plus three sub-regions (the date range and button,
  // the progress and errors, the download or failure result); the controller owns their shared
  // state. `data` is the page's `__inject` map and `pointProps` what its points receive.
  let {
    pointProps,
    data,
  }: {
    pointProps: InjectionPointExtras<'settings.audit.export'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const controller = new AuditExportController()
</script>

<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Export</h2>
  <p class="mt-1 text-sm text-slate-600">
    Export audit events as CSV. A mandatory integrity check runs first.
  </p>

  <AuditExportForm {controller} {pointProps} {data} />

  <AuditExportStatus {controller} {pointProps} {data} />

  <AuditExportResult {controller} {pointProps} {data} />
</div>
