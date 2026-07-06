<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { createService } from '$lib/api/services.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { mapMonitoringSubmitError } from '$lib/monitoring/form-errors.js'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'
  import { parseAlertLeadDaysInput, toIsoDate } from '$lib/monitoring/form-helpers.js'

  let { data } = $props()

  let name = $state('')
  let url = $state('')
  let renewalDate = $state('')
  let alertLeadDays = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ name?: string }>({})

  const canCreate = $derived(canManageMonitoredAssets(data.orgRole))

  async function submitForm() {
    if (submitting || !canCreate) return
    fieldErrors = name.trim() ? {} : { name: 'Name is required' }
    if (fieldErrors.name) return

    submitting = true
    errorMessage = null
    try {
      const body: {
        name: string
        url?: string
        renewalDate?: string
        alertLeadDays?: number[]
      } = { name: name.trim() }
      if (url.trim()) body.url = url.trim()
      if (renewalDate) body.renewalDate = toIsoDate(renewalDate)
      const parsedLeadDays = parseAlertLeadDaysInput(alertLeadDays)
      if (parsedLeadDays) body.alertLeadDays = parsedLeadDays

      const created = await createService(fetch, data.projectId, body)
      await goto(resolve(`/projects/${data.projectId}/services/${created.id}`))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to create services.'
      )
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
    }
  }
</script>

<svelte:head>
  <title>New service | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New service</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Add service</h1>
  </div>

  {#if !canCreate}
    <AccessNotice
      title="Create not available"
      message="Service creation requires Member access or higher. Ask your administrator to upgrade your role."
      backHref={`/projects/${data.projectId}/services`}
      backLabel="Back to services"
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
        <label class="block font-medium text-slate-900" for="service-name">Name</label>
        <input
          id="service-name"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          bind:value={name}
        />
        {#if fieldErrors.name}
          <p class="text-sm text-red-700">{fieldErrors.name}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="service-url">URL (optional)</label>
        <input
          id="service-url"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          bind:value={url}
        />
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="service-renewal-date">
          Renewal date (optional)
        </label>
        <input
          id="service-renewal-date"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="date"
          bind:value={renewalDate}
        />
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="service-alert-lead-days">
          Alert me before renewal (days, comma-separated)
        </label>
        <input
          id="service-alert-lead-days"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          placeholder="14, 3"
          bind:value={alertLeadDays}
        />
      </div>

      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}

      <FormSubmitRow
        submitLabel="Create service"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/services`}
        {submitting}
      />
    </form>
  {/if}
</section>
