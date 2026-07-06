<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { CHECK_FREQUENCY_MINUTES, createServiceEndpoint } from '$lib/api/service-endpoints.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import {
    AssetForm,
    FieldInput,
    FormErrorBanner,
    ServiceEndpointFormState,
    ServiceEndpointFrequencyThresholdFields,
  } from '$lib/components/monitoring/index.js'
  import { canManageMonitoredAssets, mapMonitoringSubmitError } from '$lib/monitoring/index.js'

  let { data } = $props()

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

<svelte:head>
  <title>New endpoint | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New endpoint</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Add endpoint</h1>
  </div>

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
</section>
