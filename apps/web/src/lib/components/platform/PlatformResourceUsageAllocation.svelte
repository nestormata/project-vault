<script lang="ts">
  import type { ResourceUsageResponse } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import type { AuditQuotaEditor } from './audit-quota-editor.svelte.js'

  // Story 22.3 AC-6/AC-7, Story 69.14: the allocation summary and the truncation and staleness
  // notices above the per-organization table as one replaceable region.
  let {
    usage: u,
    editor,
    data,
  }: {
    usage: ResourceUsageResponse
    editor: AuditQuotaEditor
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const allocation = $derived({
    truncated: u.truncated ?? false,
    allocatedLogicalBytes: u.allocatedLogicalBytes ?? 0,
    estimatedPhysicalBytes: u.estimatedPhysicalBytes ?? 0,
    allocationIncludesUnlimitedOrgs: u.allocationIncludesUnlimitedOrgs ?? false,
    observedPhysicalToLogicalRatio: u.observedPhysicalToLogicalRatio ?? null,
  })
</script>

<!-- @region platform.settings-resource-usage.allocation -->
<RegionFragment>
  {#if editor.rows.length > 0}
    {@const allocatedPct =
      allocation.estimatedPhysicalBytes && u.auditLogStorage.limitBytes
        ? Math.round((allocation.estimatedPhysicalBytes / u.auditLogStorage.limitBytes) * 1000) / 10
        : 0}
    <p class="mt-2 text-sm text-gray-700">
      {allocation.allocationIncludesUnlimitedOrgs ? '≥' : '≈'}
      Σ per-organization quotas: {formatBytes(allocation.allocatedLogicalBytes)} logical (≈ {formatBytes(
        allocation.estimatedPhysicalBytes
      )} estimated physical, {allocatedPct}% of the {formatBytes(u.auditLogStorage.limitBytes)} instance
      limit)
      {#if allocation.allocationIncludesUnlimitedOrgs}
        <span class="block text-xs text-amber-700"
          >One or more organizations are unlimited — this is a lower bound; the true figure may be
          higher.</span
        >
      {/if}
      {#if allocation.observedPhysicalToLogicalRatio !== null}
        <span class="block text-xs text-gray-500">
          Observed ratio: {Math.round(allocation.observedPhysicalToLogicalRatio * 100) / 100}× —
          static estimate used for the bound above.
        </span>
      {/if}
    </p>
  {/if}

  {#if allocation.truncated}
    <p class="mt-2 text-xs text-amber-700" role="status">
      Showing the {editor.rows.length} highest-utilization organizations of more on this instance.
    </p>
  {/if}

  {#if editor.rows.some((r) => r.state === 'stale')}
    <p class="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
      Audit-storage usage figures may be out of date — the reconciliation job has not run recently
      for one or more organizations.
    </p>
  {/if}<InjectionPoint name="platform.settings-resource-usage.allocation" {data} />
</RegionFragment>
