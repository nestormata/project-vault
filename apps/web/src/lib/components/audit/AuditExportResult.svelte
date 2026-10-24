<script lang="ts">
  import { auditExportDownloadUrl } from '$lib/api/audit.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import type { AuditExportController } from './audit-export-controller.svelte.js'

  // Story 69.12: how the export ended, the CSV download link or the integrity failure notice.
  let {
    controller,
    pointProps,
    data,
  }: {
    controller: AuditExportController
    pointProps: InjectionPointExtras<'settings.audit.export'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const integrityFailedRecordCount = $derived(controller.integritySummary?.failedCount ?? 0)
</script>

<!-- @region settings.audit.export-result -->
<RegionFragment>
  {#if controller.status === 'completed' && controller.jobId}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- D3: plain <a href> to a non-page API download endpoint, not a SvelteKit route resolve() can type-check. (`-next-line` doesn't reach the `href` line on a multi-line tag, so this needs the block form.) -->
    <a
      href={auditExportDownloadUrl(controller.jobId)}
      class="mt-4 inline-block rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800"
    >
      Download CSV
    </a>
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {/if}

  {#if controller.status === 'failed'}
    <p class="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      Export failed: integrity verification detected {integrityFailedRecordCount} tampered record(s).
      See the Integrity Verification panel below for details.
    </p>
  {/if}<InjectionPoint name="settings.audit.export-result" props={pointProps} {data} />
</RegionFragment>
