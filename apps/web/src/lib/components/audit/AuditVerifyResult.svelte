<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import type { AuditVerifyController } from './audit-verify-controller.svelte.js'

  // Story 69.12: Story 8.1's own AC-15/UX-DR13 requirement: the response's `summary` string is the
  // headline result, rendered verbatim (not a raw JSON dump), "designed to be comprehensible to a
  // non-cryptographer", followed by the records that failed verification.
  let {
    controller,
    pointProps,
    data,
  }: {
    controller: AuditVerifyController
    pointProps: InjectionPointExtras<'settings.audit.verify'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const result = $derived(controller.result)
</script>

<!-- @region settings.audit.verify-result -->
<RegionFragment>
  {#if result}
    {#if result.rowsChecked === 0}
      <p class="mt-4 text-sm text-slate-600">No audit events in this range to verify.</p>
    {:else}
      <p
        class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"
      >
        {result.summary}
      </p>
    {/if}

    {#if result.failed.length > 0}
      <div class="mt-4 rounded-xl border border-red-300 bg-red-50 p-4">
        <p class="text-sm font-semibold text-red-800">
          {result.failedCount} record{result.failedCount === 1 ? '' : 's'} failed verification:
        </p>
        <ul class="mt-2 space-y-1 text-sm text-red-800">
          {#each result.failed as row (row.id)}
            <li>{row.eventType} — {row.timestamp}</li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}<InjectionPoint name="settings.audit.verify-result" props={pointProps} {data} />
</RegionFragment>
