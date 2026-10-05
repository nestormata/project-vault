<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/service-endpoints/new/$types.js'
  import type { Snippet } from 'svelte'
  import { canManageMonitoredAssets, mapMonitoringSubmitError } from '$lib/monitoring/index.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { CHECK_FREQUENCY_MINUTES, createServiceEndpoint } from '$lib/api/service-endpoints.js'
  import {
    AssetForm,
    FieldInput,
    FormErrorBanner,
    ServiceEndpointFormState,
    ServiceEndpointFrequencyThresholdFields,
  } from '$lib/components/monitoring/index.js'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'

  let { data, children }: { data: PageData; children?: Snippet } = $props()

  const form = new ServiceEndpointFormState()
  const canCreate = $derived(canManageMonitoredAssets(data.orgRole))
  function validate(): { name?: string; url?: string } {
    const errors: { name?: string; url?: string } = {}
    if (!form.name.trim()) errors.name = 'Name is required'
    if (!form.url.trim()) errors.url = 'URL is required'
    return errors
  }
  async function submitForm() {
    if (form.submitting || !canCreate) return
    form.fieldErrors = validate()
    if (form.fieldErrors.name || form.fieldErrors.url) return

    form.submitting = true
    form.errorMessage = null
    try {
      const created = await createServiceEndpoint(fetch, data.projectId, {
        name: form.name.trim(),
        url: form.url.trim(),
        checkFrequencyMinutes: form.checkFrequencyMinutes,
        downThresholdFailures: form.downThresholdFailures,
      })
      await goto(resolve(`/projects/${data.projectId}/service-endpoints/${created.id}`))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to create service endpoints.'
      )
      form.fieldErrors = mapped.fieldErrors
      form.errorMessage = mapped.errorMessage
    } finally {
      form.submitting = false
    }
  }
</script>

{@render children?.()}
{#if !canCreate}
  <AccessNotice
    title="Create not available"
    message="Endpoint creation requires Member access or higher. Ask your administrator to upgrade your role."
    backHref={`/projects/${data.projectId}/service-endpoints`}
    backLabel="Back to endpoints"
  />
{:else}
  <AssetForm onsubmit={submitForm}>
    <FieldInput
      id="endpoint-name"
      label="Name"
      bind:value={form.name}
      error={form.fieldErrors.name}
    />
    <FieldInput
      id="endpoint-url"
      label="URL"
      placeholder="https://api.example.com/health"
      bind:value={form.url}
      error={form.fieldErrors.url}
    />
    <ServiceEndpointFrequencyThresholdFields
      frequencyOptions={CHECK_FREQUENCY_MINUTES}
      bind:checkFrequencyMinutes={form.checkFrequencyMinutes}
      bind:downThresholdFailures={form.downThresholdFailures}
    />

    <FormErrorBanner message={form.errorMessage} />

    <FormSubmitRow
      submitLabel="Create endpoint"
      pendingLabel="Creating…"
      cancelHref={`/projects/${data.projectId}/service-endpoints`}
      submitting={form.submitting}
    />
  </AssetForm>
{/if}
