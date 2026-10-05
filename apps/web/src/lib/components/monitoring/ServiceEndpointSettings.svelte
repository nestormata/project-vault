<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { EndpointRowPointProps } from '$lib/components/composition/injection-points.js'
  import { CHECK_FREQUENCY_MINUTES, updateServiceEndpoint } from '$lib/api/service-endpoints.js'
  import type { ServiceEndpointDetail } from '$lib/api/service-endpoints.js'
  import { canManageMonitoredAssets, mapMonitoringSubmitError } from '$lib/monitoring/index.js'
  import AssetForm from './AssetForm.svelte'
  import FieldInput from './FieldInput.svelte'
  import ReadOnlyField from './ReadOnlyField.svelte'
  import ReadOnlyPanel from './ReadOnlyPanel.svelte'
  import SaveChangesFooter from './SaveChangesFooter.svelte'
  import { ServiceEndpointFormState } from './service-endpoint-form-state.svelte.js'
  import ServiceEndpointFrequencyThresholdFields from './ServiceEndpointFrequencyThresholdFields.svelte'

  // Story 69.3: the endpoint detail page's edit form (or the read-only panel for a role that cannot
  // manage) as one replaceable region. It owns the form state and the submit handler and reports a
  // saved endpoint through `onUpdated`. A contribution at
  // `project.service-endpoints-detail.settings` receives `{ project, endpoint, orgRole }` and renders
  // right after the form or the panel, in both states.
  let {
    project,
    endpoint,
    orgRole,
    projectId,
    onUpdated,
    data,
  }: {
    project: EndpointRowPointProps['project']
    endpoint: EndpointRowPointProps['endpoint']
    orgRole: EndpointRowPointProps['orgRole']
    projectId: string
    onUpdated: (updated: ServiceEndpointDetail) => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const canManage = $derived(canManageMonitoredAssets(orgRole))

  // AC-E4: unlike services/certificates/domains, the endpoint edit form diffs against the loaded
  // values and PATCHes only what actually changed. `url` in particular starts blank (a fresh
  // entry) rather than pre-filled with the already-redacted display value — Background explicitly
  // forbids trying to "restore" or edit around the redaction.
  const form = new ServiceEndpointFormState()

  $effect(() => {
    form.name = endpoint.name
    form.url = ''
    form.checkFrequencyMinutes = endpoint.checkFrequencyMinutes
    form.downThresholdFailures = endpoint.downThresholdFailures
  })

  async function submitForm() {
    if (form.submitting || !canManage) return
    form.fieldErrors = form.name.trim() ? {} : { name: 'Name is required' }
    if (form.fieldErrors.name) return

    const changes: {
      name?: string
      url?: string
      checkFrequencyMinutes?: number
      downThresholdFailures?: number
    } = {}
    if (form.name.trim() !== endpoint.name) changes.name = form.name.trim()
    if (form.url.trim()) changes.url = form.url.trim()
    if (form.checkFrequencyMinutes !== endpoint.checkFrequencyMinutes) {
      changes.checkFrequencyMinutes = form.checkFrequencyMinutes
    }
    if (form.downThresholdFailures !== endpoint.downThresholdFailures) {
      changes.downThresholdFailures = form.downThresholdFailures
    }
    if (Object.keys(changes).length === 0) return

    form.submitting = true
    form.errorMessage = null
    try {
      onUpdated(await updateServiceEndpoint(fetch, projectId, endpoint.id, changes))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to edit service endpoints.'
      )
      form.fieldErrors = mapped.fieldErrors as { name?: string }
      form.errorMessage = mapped.errorMessage
    } finally {
      form.submitting = false
    }
  }
</script>

<!-- @region project.service-endpoints-detail.settings -->
<RegionFragment>
  {#if canManage}
    <AssetForm onsubmit={submitForm}>
      <FieldInput
        id="endpoint-name"
        label="Name"
        bind:value={form.name}
        error={form.fieldErrors.name}
      />
      <FieldInput
        id="endpoint-url"
        label="New URL (leave blank to keep current)"
        placeholder="https://api.example.com/health"
        bind:value={form.url}
      />
      <ServiceEndpointFrequencyThresholdFields
        frequencyOptions={CHECK_FREQUENCY_MINUTES}
        bind:checkFrequencyMinutes={form.checkFrequencyMinutes}
        bind:downThresholdFailures={form.downThresholdFailures}
      />

      <SaveChangesFooter
        errorMessage={form.errorMessage}
        cancelHref={`/projects/${projectId}/service-endpoints`}
        submitting={form.submitting}
      />
    </AssetForm>
  {:else}
    <ReadOnlyPanel>
      <ReadOnlyField
        label="Check frequency"
        value={`Checked every ${endpoint.checkFrequencyMinutes} min`}
      />
      <ReadOnlyField
        label="Failure threshold"
        value={`Down after ${endpoint.downThresholdFailures} consecutive failures`}
      />
    </ReadOnlyPanel>
  {/if}<InjectionPoint
    name="project.service-endpoints-detail.settings"
    props={{ project, endpoint, orgRole }}
    {data}
  />
</RegionFragment>
