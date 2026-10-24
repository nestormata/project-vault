<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { runAccessReportCsv, type AccessReportResult } from '$lib/api/audit.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { triggerTextDownload } from '$lib/download.js'

  // Story 69.11: the summary row of a generated access report (its as-of date, when it was
  // generated, and the CSV download). It owns the download state; nothing else reads it.
  let {
    report,
    asOf,
    page,
    data,
  }: {
    report: AccessReportResult
    asOf: string | undefined
    page: number | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  let downloadError = $state<string | null>(null)
  let downloading = $state(false)
  // AC-G3 — the filename is constructed client-side since the server supplies no
  // Content-Disposition header for this endpoint.
  async function onDownloadCsv() {
    if (downloading) return
    downloading = true
    downloadError = null
    try {
      const csv = await runAccessReportCsv(fetch, { asOf, page: page ?? 1, limit: 20 })
      const suffix = asOf ? asOf.slice(0, 10) : 'current'
      triggerTextDownload(`access-report-${suffix}.csv`, 'text/csv', csv)
    } catch (err) {
      downloadError =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to download CSV')
          : 'Failed to download CSV'
    } finally {
      downloading = false
    }
  }
</script>

<!-- @region settings.audit-access-report.summary -->
<RegionFragment>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm text-slate-600">
      As of: <strong>{report.asOf.slice(0, 10)}</strong>
      — generated at {new Date(report.generatedAt).toLocaleString()}
    </p>
    <button
      type="button"
      class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
      disabled={downloading}
      onclick={() => void onDownloadCsv()}
    >
      {downloading ? 'Preparing…' : 'Download CSV'}
    </button>
  </div>
  {#if downloadError}
    <p class="mt-2 text-sm text-red-700" role="alert">{downloadError}</p>
  {/if}<InjectionPoint name="settings.audit-access-report.summary" {data} />
</RegionFragment>
