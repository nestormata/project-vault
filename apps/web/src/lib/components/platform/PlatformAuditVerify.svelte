<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import {
    verifyPlatformAuditIntegrity,
    type PlatformAuditVerifyResult as VerifyResult,
  } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import PlatformAuditVerifyResult from './PlatformAuditVerifyResult.svelte'

  // Story 69.10: the "Verify Integrity" card of the platform audit log as one replaceable region.
  // Its state (the date range, the running flag, the outcome) is used by this card only (moved
  // verbatim from the content component).
  let {
    data,
  }: {
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  let verifyFrom = $state('')
  let verifyTo = $state('')
  let verifyResult = $state<VerifyResult | null>(null)
  let verifyError = $state<string | null>(null)
  let verifying = $state(false)
  async function handleVerify(e: SubmitEvent) {
    e.preventDefault()
    if (!verifyFrom || !verifyTo) return
    verifying = true
    verifyResult = null
    verifyError = null
    try {
      const result = await verifyPlatformAuditIntegrity(fetch, { from: verifyFrom, to: verifyTo })
      verifyResult = result
    } catch (err) {
      verifyError =
        err instanceof ApiClientError
          ? (err.message ?? 'Verification failed')
          : 'Verification failed'
    } finally {
      verifying = false
    }
  }
  const verifyEnabled = $derived(verifyFrom.length > 0 && verifyTo.length > 0)
</script>

<!-- @region platform.audit.verify -->
<div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Verify Integrity</h2>
  <p class="mt-1 text-sm text-slate-500">
    Run an HMAC integrity check over a date range. Both dates are required.
  </p>
  <form class="mt-4 flex flex-wrap items-end gap-3" onsubmit={(e) => void handleVerify(e)}>
    <label class="flex flex-col text-sm text-slate-700" for="verify-from">
      From
      <input
        id="verify-from"
        type="text"
        bind:value={verifyFrom}
        placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
        aria-describedby="platform-audit-verify-from-help"
      />
      <FormHelpText id="platform-audit-verify-from-help" kind="date" />
    </label>
    <label class="flex flex-col text-sm text-slate-700" for="verify-to">
      To
      <input
        id="verify-to"
        type="text"
        bind:value={verifyTo}
        placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
        aria-describedby="platform-audit-verify-to-help"
      />
      <FormHelpText id="platform-audit-verify-to-help" kind="date" />
    </label>
    <button
      type="submit"
      disabled={!verifyEnabled || verifying}
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
    >
      {verifying ? 'Verifying\u2026' : 'Verify integrity'}
    </button>
  </form>

  {#if verifyError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {verifyError}
    </p>
  {/if}

  {#if verifyResult}
    <PlatformAuditVerifyResult result={verifyResult} />
  {/if}<InjectionPoint name="platform.audit.verify" {data} />
</div>
