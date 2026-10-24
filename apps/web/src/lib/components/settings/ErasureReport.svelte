<script lang="ts">
  import type { ErasureReport as Report } from '$lib/api/compliance.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { triggerJsonDownload } from '$lib/download.js'
  import ErasureReportAuditEvent from './ErasureReportAuditEvent.svelte'

  // Story 69.11: the compliance report of a completed erasure (what was removed and retained, with a
  // JSON download).
  let {
    requestId,
    report,
    data,
  }: {
    requestId: string
    report: Report
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  function onDownloadReport() {
    triggerJsonDownload(`erasure-report-${requestId}.json`, report)
  }
</script>

<!-- @region settings.users-erasure-detail.report -->
<div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-semibold text-slate-950">Compliance Report</h2>
    <button
      type="button"
      class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
      onclick={onDownloadReport}
    >
      Download compliance report
    </button>
  </div>
  <p class="mt-1 text-sm text-slate-600">
    Executed at {new Date(report.executedAt).toLocaleString()}
  </p>

  <h3 class="mt-4 text-sm font-semibold text-slate-900">What was removed</h3>
  <ul class="mt-2 space-y-1 text-sm text-slate-700">
    {#each report.piiRemoved as entry (entry.table)}
      <li>{entry.table} — {entry.fields.join(', ')} — {entry.method}</li>
    {/each}
  </ul>

  <h3 class="mt-4 text-sm font-semibold text-slate-900">What was retained</h3>
  <ul class="mt-2 space-y-1 text-sm text-slate-700">
    {#each report.piiRetained as entry (entry.table)}
      <li>{entry.table} — {entry.reason}</li>
    {/each}
  </ul>

  <p class="mt-4 text-sm text-slate-700">
    <span class="font-semibold">Retention justification:</span>
    {report.retentionJustification}
  </p>

  <ErasureReportAuditEvent auditEventId={report.auditEventId} /><InjectionPoint
    name="settings.users-erasure-detail.report"
    {data}
  />
</div>
