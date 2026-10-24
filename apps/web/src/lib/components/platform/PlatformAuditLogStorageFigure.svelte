<script lang="ts">
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import { thresholdClass, thresholdLabel } from './resource-usage-format.js'

  // Story 69.14: the physical audit log storage figure (uses the backend-computed utilizationPct
  // directly) with its threshold label.
  let {
    auditLogStorage,
  }: { auditLogStorage: { currentBytes: number; limitBytes: number; utilizationPct: number } } =
    $props()
</script>

<p class="mt-2 text-sm">
  <span class={thresholdClass(auditLogStorage.utilizationPct)}>
    {formatBytes(auditLogStorage.currentBytes)} / {formatBytes(auditLogStorage.limitBytes)}
    ({auditLogStorage.utilizationPct}%)
  </span>
  {#if thresholdLabel(auditLogStorage.utilizationPct)}
    <span class="ml-2 text-xs font-semibold">
      {thresholdLabel(auditLogStorage.utilizationPct)} — critical threshold is 95%.
    </span>
  {/if}
</p>
