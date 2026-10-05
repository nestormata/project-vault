<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/services/new/$types.js'
  import type { Snippet } from 'svelte'
  import {
    canManageMonitoredAssets,
    mapMonitoringSubmitError,
    parseAlertLeadDaysInput,
    toIsoDate,
  } from '$lib/monitoring/index.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { createService } from '$lib/api/services.js'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { AssetForm, FieldInput, FormErrorBanner } from '$lib/components/monitoring/index.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'

  let { data, children }: { data: PageData; children?: Snippet } = $props()

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

{@render children?.()}
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
