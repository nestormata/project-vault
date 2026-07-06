<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { createDomain } from '$lib/api/domains.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { mapMonitoringSubmitError } from '$lib/monitoring/form-errors.js'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'
  import { parseAlertLeadDaysInput, toIsoDate } from '$lib/monitoring/form-helpers.js'

  let { data } = $props()

  let domainName = $state('')
  let renewalDate = $state('')
  let alertLeadDays = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ domainName?: string; renewalDate?: string }>({})

  const canCreate = $derived(canManageMonitoredAssets(data.orgRole))

  function validate(): { domainName?: string; renewalDate?: string } {
    const errors: { domainName?: string; renewalDate?: string } = {}
    if (!domainName.trim()) errors.domainName = 'Domain name is required'
    if (!renewalDate) errors.renewalDate = 'Renewal date is required'
    return errors
  }

  async function submitForm() {
    if (submitting || !canCreate) return
    fieldErrors = validate()
    if (fieldErrors.domainName || fieldErrors.renewalDate) return

    submitting = true
    errorMessage = null
    try {
      const body: { domainName: string; renewalDate: string; alertLeadDays?: number[] } = {
        domainName: domainName.trim(),
        renewalDate: toIsoDate(renewalDate),
      }
      const parsedLeadDays = parseAlertLeadDaysInput(alertLeadDays)
      if (parsedLeadDays) body.alertLeadDays = parsedLeadDays

      const created = await createDomain(fetch, data.projectId, body)
      await goto(resolve(`/projects/${data.projectId}/domains/${created.id}`))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to create domains.'
      )
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
    }
  }
</script>

<svelte:head>
  <title>New domain | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New domain</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Add domain</h1>
  </div>

  {#if !canCreate}
    <AccessNotice
      title="Create not available"
      message="Domain creation requires Member access or higher. Ask your administrator to upgrade your role."
      backHref={`/projects/${data.projectId}/domains`}
      backLabel="Back to domains"
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
        <label class="block font-medium text-slate-900" for="domain-name">Domain name</label>
        <input
          id="domain-name"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          bind:value={domainName}
        />
        {#if fieldErrors.domainName}
          <p class="text-sm text-red-700">{fieldErrors.domainName}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="domain-renewal-date"
          >Renewal date</label
        >
        <input
          id="domain-renewal-date"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="date"
          bind:value={renewalDate}
        />
        {#if fieldErrors.renewalDate}
          <p class="text-sm text-red-700">{fieldErrors.renewalDate}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="domain-alert-lead-days">
          Alert me before renewal (days, comma-separated)
        </label>
        <input
          id="domain-alert-lead-days"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          placeholder="30"
          bind:value={alertLeadDays}
        />
      </div>

      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}

      <FormSubmitRow
        submitLabel="Create domain"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/domains`}
        {submitting}
      />
    </form>
  {/if}
</section>
