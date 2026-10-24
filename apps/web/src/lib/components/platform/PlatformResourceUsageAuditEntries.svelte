<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PlatformUsageMeter from './PlatformUsageMeter.svelte'
  import { pct } from './resource-usage-format.js'

  // Story 69.14: the audit log entries count card as one replaceable region.
  let {
    auditLogEntries,
    data,
  }: {
    auditLogEntries: { current: number; limit: number | null }
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.audit-entries -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-base font-semibold text-gray-900">Audit Log Entries</h2>
  <PlatformUsageMeter
    text="{auditLogEntries.current.toLocaleString()} / {auditLogEntries.limit?.toLocaleString() ??
      'No limit configured'}"
    pct={pct(auditLogEntries.current, auditLogEntries.limit)}
  /><InjectionPoint name="platform.settings-resource-usage.audit-entries" {data} />
</section>
