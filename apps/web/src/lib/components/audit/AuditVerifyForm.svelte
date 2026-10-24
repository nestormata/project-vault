<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { AuditVerifyController } from './audit-verify-controller.svelte.js'

  // Story 69.12: the date range and the Run integrity check button of the verify card. The
  // controller owns the dates and the run.
  let {
    controller,
    pointProps,
    data,
  }: {
    controller: AuditVerifyController
    pointProps: InjectionPointExtras<'settings.audit.verify'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit.verify-form -->
<div class="mt-4 flex flex-wrap items-end gap-3">
  <label class="flex flex-col text-sm text-slate-700" for="verify-from">
    From
    <input
      id="verify-from"
      type="date"
      class="rounded-lg border border-slate-300 px-2 py-1"
      bind:value={controller.from}
      aria-describedby="audit-verify-date-help"
    />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="verify-to">
    To
    <input
      id="verify-to"
      type="date"
      class="rounded-lg border border-slate-300 px-2 py-1"
      bind:value={controller.to}
      aria-describedby="audit-verify-date-help"
    />
  </label>
  <FormHelpText id="audit-verify-date-help" kind="date" />
  <button
    type="button"
    class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
    disabled={controller.running || !controller.from || !controller.to}
    onclick={() => void controller.run()}
  >
    {controller.running ? 'Checking…' : 'Run integrity check'}
  </button><InjectionPoint name="settings.audit.verify-form" props={pointProps} {data} />
</div>
