<script lang="ts">
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import { AuditVerifyController } from './audit-verify-controller.svelte.js'
  import AuditVerifyError from './AuditVerifyError.svelte'
  import AuditVerifyForm from './AuditVerifyForm.svelte'
  import AuditVerifyResult from './AuditVerifyResult.svelte'

  // Story 69.12: AC group D, Audit Integrity Verification. The card is the heading plus three
  // sub-regions (the date range and button, the error, the result); the controller owns their shared
  // state. `data` is the page's `__inject` map and `pointProps` what its points receive.
  let {
    pointProps,
    data,
  }: {
    pointProps: InjectionPointExtras<'settings.audit.verify'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const controller = new AuditVerifyController()
</script>

<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Integrity Verification</h2>
  <p class="mt-1 text-sm text-slate-600">
    Verify that audit events in a date range have not been tampered with (range of 90 days or
    fewer).
  </p>

  <AuditVerifyForm {controller} {pointProps} {data} />

  <AuditVerifyError {controller} {pointProps} {data} />

  <AuditVerifyResult {controller} {pointProps} {data} />
</div>
