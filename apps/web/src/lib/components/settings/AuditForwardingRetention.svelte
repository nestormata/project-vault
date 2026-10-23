<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { updateAuditRetention } from '$lib/api/audit.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the Retention card of the forwarding page as one replaceable region. Its state is
  // used by this card only, so it lives here (moved verbatim from the panel).
  let {
    data,
  }: {
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const RETENTION_MIN_DAYS = 30
  const RETENTION_MAX_DAYS = 3650
  let retentionDaysInput = $state('')
  let retainForever = $state(false)
  let retentionClientError = $state<string | null>(null)
  let retentionServerError = $state<string | null>(null)
  let retentionSaving = $state(false)
  let retentionConfirmation = $state<string | null>(null)
  async function onSaveRetention() {
    retentionClientError = null
    retentionServerError = null
    retentionConfirmation = null

    let retentionDays: number | null
    if (retainForever) {
      retentionDays = null
    } else {
      const parsed = Number(retentionDaysInput)
      if (!Number.isInteger(parsed) || parsed < RETENTION_MIN_DAYS || parsed > RETENTION_MAX_DAYS) {
        retentionClientError = `Retention must be between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS.toLocaleString()} days`
        return
      }
      retentionDays = parsed
    }

    retentionSaving = true
    try {
      const result = await updateAuditRetention(fetch, retentionDays)
      retentionConfirmation =
        result.retentionDays === null
          ? 'Audit events will be retained indefinitely.'
          : `Retention set to ${result.retentionDays} days.`
    } catch (err) {
      retentionServerError =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to update retention')
          : 'Failed to update retention'
    } finally {
      retentionSaving = false
    }
  }
</script>

<!-- @region settings.audit-forwarding.retention -->
<div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Retention</h2>
  <p class="mt-2 text-sm font-medium text-amber-800">
    Project Vault does not currently display your saved retention configuration — this form always
    sets a new value.
  </p>

  <div class="mt-4 flex flex-col gap-3">
    <label class="flex flex-col text-sm text-slate-700" for="retention-days">
      Retention (days)
      <input
        id="retention-days"
        type="number"
        class="rounded-lg border border-slate-300 px-2 py-1"
        bind:value={retentionDaysInput}
        disabled={retainForever}
        aria-describedby="retention-days-help"
      />
      <FormHelpText id="retention-days-help" kind="date" />
    </label>
    <label class="flex items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" bind:checked={retainForever} aria-describedby="retain-forever-help" />
      Never automatically delete audit events
      <FormHelpText id="retain-forever-help" kind="checkbox" />
    </label>
    <button
      type="button"
      class="w-fit rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      disabled={retentionSaving}
      onclick={() => void onSaveRetention()}
    >
      {retentionSaving ? 'Saving…' : 'Save retention'}
    </button>
    {#if retentionClientError}
      <p class="text-sm text-red-700" role="alert">{retentionClientError}</p>
    {/if}
    {#if retentionServerError}
      <p class="text-sm text-red-700" role="alert">{retentionServerError}</p>
    {/if}
    {#if retentionConfirmation}
      <p class="text-sm text-emerald-700">{retentionConfirmation}</p>
    {/if}<InjectionPoint name="settings.audit-forwarding.retention" {data} />
  </div>
</div>
