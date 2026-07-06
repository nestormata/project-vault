<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { createCertificate } from '$lib/api/certificates.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { mapMonitoringSubmitError } from '$lib/monitoring/form-errors.js'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'
  import { parseAlertLeadDaysInput, toIsoDate } from '$lib/monitoring/form-helpers.js'

  let { data } = $props()

  let domain = $state('')
  let expiresAt = $state('')
  let alertLeadDays = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ domain?: string; expiresAt?: string }>({})

  const canCreate = $derived(canManageMonitoredAssets(data.orgRole))

  function validate(): { domain?: string; expiresAt?: string } {
    const errors: { domain?: string; expiresAt?: string } = {}
    if (!domain.trim()) errors.domain = 'Domain is required'
    else if (domain.trim().length > 253) errors.domain = 'Domain must be 253 characters or fewer'
    if (!expiresAt) errors.expiresAt = 'Expiry date is required'
    return errors
  }

  async function submitForm() {
    if (submitting || !canCreate) return
    fieldErrors = validate()
    if (fieldErrors.domain || fieldErrors.expiresAt) return

    submitting = true
    errorMessage = null
    try {
      const body: { domain: string; expiresAt: string; alertLeadDays?: number[] } = {
        domain: domain.trim(),
        expiresAt: toIsoDate(expiresAt),
      }
      const parsedLeadDays = parseAlertLeadDaysInput(alertLeadDays)
      if (parsedLeadDays) body.alertLeadDays = parsedLeadDays

      const created = await createCertificate(fetch, data.projectId, body)
      await goto(resolve(`/projects/${data.projectId}/certificates/${created.id}`))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to create certificates.'
      )
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
    }
  }
</script>

<svelte:head>
  <title>New certificate | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New certificate</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Add certificate</h1>
  </div>

  {#if !canCreate}
    <AccessNotice
      title="Create not available"
      message="Certificate creation requires Member access or higher. Ask your administrator to upgrade your role."
      backHref={`/projects/${data.projectId}/certificates`}
      backLabel="Back to certificates"
    />
  {:else}
    <form
      class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      onsubmit={(event) => {
        event.preventDefault()
        void submitForm()
      }}
    >
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="certificate-domain">Domain</label>
        <input
          id="certificate-domain"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          bind:value={domain}
        />
        {#if fieldErrors.domain}
          <p class="text-sm text-red-700">{fieldErrors.domain}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="certificate-expires-at"
          >Expiry date</label
        >
        <input
          id="certificate-expires-at"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="date"
          bind:value={expiresAt}
        />
        {#if fieldErrors.expiresAt}
          <p class="text-sm text-red-700">{fieldErrors.expiresAt}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="certificate-alert-lead-days">
          Alert me before expiry (days, comma-separated)
        </label>
        <input
          id="certificate-alert-lead-days"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          placeholder="30, 7"
          bind:value={alertLeadDays}
        />
      </div>

      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}

      <FormSubmitRow
        submitLabel="Create certificate"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/certificates`}
        {submitting}
      />
    </form>
  {/if}
</section>
