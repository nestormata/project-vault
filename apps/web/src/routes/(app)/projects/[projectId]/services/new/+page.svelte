<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { createService } from '$lib/api/services.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { AssetForm, FieldInput, FormErrorBanner } from '$lib/components/monitoring/index.js'
  import {
    canManageMonitoredAssets,
    mapMonitoringSubmitError,
    parseAlertLeadDaysInput,
    toIsoDate,
  } from '$lib/monitoring/index.js'

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
    <AssetForm onsubmit={submitForm}>
      <FieldInput id="service-name" label="Name" bind:value={name} error={fieldErrors.name} />
      <FieldInput id="service-url" label="URL (optional)" bind:value={url} />
      <FieldInput
        id="service-renewal-date"
        label="Renewal date (optional)"
        type="date"
        bind:value={renewalDate}
      />
      <FieldInput
        id="service-alert-lead-days"
        label="Alert me before renewal (days, comma-separated)"
        placeholder="14, 3"
        bind:value={alertLeadDays}
      />

      <FormErrorBanner message={errorMessage} />

      <FormSubmitRow
        submitLabel="Create service"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/services`}
        {submitting}
      />
    </AssetForm>
  {/if}
</section>
