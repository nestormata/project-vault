<script lang="ts">
  import type { MaintenanceModeStatus } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.10: the maintenance-mode status banner at the top of the platform audit log as one
  // replaceable region. The content component owns the status (the maintenance panel refreshes it).
  let {
    status,
    statusError,
    data,
  }: {
    status: MaintenanceModeStatus | null
    statusError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.audit.maintenance-status -->
<RegionFragment>
  {#if statusError}
    <div
      class="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900"
      role="alert"
    >
      ⚠ {statusError}
    </div>
  {:else if status?.active}
    <div
      class="sticky top-0 z-10 mt-4 rounded-lg border-2 border-red-400 bg-red-50 px-4 py-3 text-sm text-red-900"
      role="alert"
    >
      <p class="font-bold">⚠ Maintenance mode is ACTIVE</p>
      <p class="mt-1">
        Activated: {status.activatedAt ? new Date(status.activatedAt).toLocaleString() : '—'}
        — Reason: {status.reason ?? '—'}
        — {status.pendingEntriesCount} entries queued.
      </p>
      <p class="mt-1 text-xs">The fail-closed audit guarantee is currently bypassed.</p>
    </div>
  {:else if status}
    <div class="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-600">
      Maintenance mode: inactive
    </div>
  {/if}<InjectionPoint name="platform.audit.maintenance-status" {data} />
</RegionFragment>
