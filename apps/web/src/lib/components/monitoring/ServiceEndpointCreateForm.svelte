<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { CHECK_FREQUENCY_MINUTES, createServiceEndpoint } from '$lib/api/service-endpoints.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { ProjectPointProps } from '$lib/components/composition/injection-points.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { canManageMonitoredAssets, mapMonitoringSubmitError } from '$lib/monitoring/index.js'
  import type { OrgRole } from '$lib/monitoring/permissions.js'
  import AssetForm from './AssetForm.svelte'
  import FieldInput from './FieldInput.svelte'
  import FormErrorBanner from './FormErrorBanner.svelte'
  import { ServiceEndpointFormState } from './service-endpoint-form-state.svelte.js'
  import ServiceEndpointFrequencyThresholdFields from './ServiceEndpointFrequencyThresholdFields.svelte'

  // Story 69.3: the create form (or the "Create not available" notice for a role that cannot
  // create) as one replaceable region; it owns the form state and the submit handler. A
  // contribution at `project.service-endpoints-new.form` receives `{ project, orgRole }` and renders
  // right after the form or the notice, in both states.
  let {
    project,
    orgRole,
    projectId,
    data,
  }: {
    project: ProjectPointProps['project']
    orgRole: OrgRole
    projectId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const form = new ServiceEndpointFormState()

  const canCreate = $derived(canManageMonitoredAssets(orgRole))

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
      const created = await createServiceEndpoint(fetch, projectId, {
        name: form.name.trim(),
        url: form.url.trim(),
        checkFrequencyMinutes: form.checkFrequencyMinutes,
        downThresholdFailures: form.downThresholdFailures,
      })
      await goto(resolve(`/projects/${projectId}/service-endpoints/${created.id}`))
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

<!-- @region project.service-endpoints-new.form -->
<RegionFragment>
  {#if !canCreate}
    <AccessNotice
      title="Create not available"
      message="Endpoint creation requires Member access or higher. Ask your administrator to upgrade your role."
      backHref={`/projects/${projectId}/service-endpoints`}
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
        cancelHref={`/projects/${projectId}/service-endpoints`}
        submitting={form.submitting}
      />
    </AssetForm>
  {/if}<InjectionPoint
    name="project.service-endpoints-new.form"
    props={{ project, orgRole }}
    {data}
  />
</RegionFragment>
