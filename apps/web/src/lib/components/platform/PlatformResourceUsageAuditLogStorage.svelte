<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PlatformAuditLogStorageFigure from './PlatformAuditLogStorageFigure.svelte'

  // Story 69.14: the physical audit log storage card as one replaceable region.
  let {
    auditLogStorage,
    data,
  }: {
    auditLogStorage: { currentBytes: number; limitBytes: number; utilizationPct: number }
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.audit-log-storage -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-base font-semibold text-gray-900">Audit Log Storage (physical)</h2>
  <PlatformAuditLogStorageFigure {auditLogStorage} /><InjectionPoint
    name="platform.settings-resource-usage.audit-log-storage"
    {data}
  />
</section>
