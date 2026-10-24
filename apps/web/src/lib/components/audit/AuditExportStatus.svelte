<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import type { AuditExportController } from './audit-export-controller.svelte.js'

  // Story 69.12: what is happening to the export (a start or poll error, the wait, a rate limit, the
  // poll cap with its Check again button). The controller owns every flag.
  let {
    controller,
    pointProps,
    data,
  }: {
    controller: AuditExportController
    pointProps: InjectionPointExtras<'settings.audit.export'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit.export-status -->
<RegionFragment>
  {#if controller.errorMessage}
    <p
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {controller.errorMessage}
    </p>
  {/if}

  {#if controller.jobId && (controller.status === 'pending' || controller.status === 'processing') && !controller.capped}
    <p class="mt-4 text-sm text-slate-600">Verifying integrity, then generating export…</p>
  {/if}

  {#if controller.rateLimited}
    <p class="mt-4 text-sm text-amber-800">
      Checking export status is temporarily rate-limited — retrying shortly.
    </p>
  {/if}

  {#if controller.capped}
    <p class="mt-4 text-sm text-amber-800">This export is taking longer than expected.</p>
    <button
      type="button"
      class="mt-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
      onclick={() => controller.checkAgain()}
    >
      Check again
    </button>
  {/if}<InjectionPoint name="settings.audit.export-status" props={pointProps} {data} />
</RegionFragment>
