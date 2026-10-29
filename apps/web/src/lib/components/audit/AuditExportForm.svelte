<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { AuditExportRegionProps } from './audit-region-props.js'

  // Story 69.12: the date range and the Export CSV button of the export card. The controller owns
  // the dates and the trigger.
  let { controller, pointProps, data }: AuditExportRegionProps = $props()
</script>

<!-- @region settings.audit.export-form -->
<div class="mt-4 flex flex-wrap items-end gap-3">
  <label class="flex flex-col text-sm text-slate-700" for="export-from">
    From
    <input
      id="export-from"
      type="date"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      bind:value={controller.from}
      aria-describedby="audit-export-date-help"
    />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="export-to">
    To
    <input
      id="export-to"
      type="date"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      bind:value={controller.to}
      aria-describedby="audit-export-date-help"
    />
  </label>
  <FormHelpText id="audit-export-date-help" kind="date" />
  <button
    type="button"
    class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
    disabled={controller.triggering || !controller.from || !controller.to}
    onclick={() => void controller.start()}
  >
    Export CSV
  </button><InjectionPoint name="settings.audit.export-form" props={pointProps} {data} />
</div>
