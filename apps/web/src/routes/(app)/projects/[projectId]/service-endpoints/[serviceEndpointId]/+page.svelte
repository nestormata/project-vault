<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import {
    CHECK_FREQUENCY_MINUTES,
    deleteServiceEndpoint,
    getHealthHistory,
    updateServiceEndpoint,
    type HealthHistoryEntry,
    type HealthHistoryFailureReason,
  } from '$lib/api/service-endpoints.js'
  import {
    AssetDeletePanel,
    AssetForm,
    BackLink,
    DetailTitleCard,
    EntityNotFoundBanner,
    FieldInput,
    ReadOnlyField,
    ReadOnlyPanel,
    SaveChangesFooter,
    ServiceEndpointFormState,
    ServiceEndpointFrequencyThresholdFields,
  } from '$lib/components/monitoring/index.js'
  import { canManageMonitoredAssets, mapMonitoringSubmitError } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  // AC-E4: unlike services/certificates/domains, the endpoint edit form diffs against the loaded
  // values and PATCHes only what actually changed. `url` in particular starts blank (a fresh
  // entry) rather than pre-filled with the already-redacted display value — Background explicitly
  // forbids trying to "restore" or edit around the redaction.
  const form = new ServiceEndpointFormState()
  let deleteError = $state<string | null>(null)

  $effect(() => {
    form.name = data.endpoint?.name ?? ''
    form.url = ''
    form.checkFrequencyMinutes = data.endpoint?.checkFrequencyMinutes ?? 5
    form.downThresholdFailures = data.endpoint?.downThresholdFailures ?? 2
  })

  async function submitForm() {
    if (form.submitting || !canManage || !data.endpoint) return
    form.fieldErrors = form.name.trim() ? {} : { name: 'Name is required' }
    if (form.fieldErrors.name) return

    const changes: {
      name?: string
      url?: string
      checkFrequencyMinutes?: number
      downThresholdFailures?: number
    } = {}
    if (form.name.trim() !== data.endpoint.name) changes.name = form.name.trim()
    if (form.url.trim()) changes.url = form.url.trim()
    if (form.checkFrequencyMinutes !== data.endpoint.checkFrequencyMinutes) {
      changes.checkFrequencyMinutes = form.checkFrequencyMinutes
    }
    if (form.downThresholdFailures !== data.endpoint.downThresholdFailures) {
      changes.downThresholdFailures = form.downThresholdFailures
    }
    if (Object.keys(changes).length === 0) return

    form.submitting = true
    form.errorMessage = null
    try {
      const updated = await updateServiceEndpoint(fetch, data.projectId, data.endpoint.id, changes)
      data = { ...data, endpoint: updated }
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

  async function handleDelete() {
    if (!data.endpoint) return
    deleteError = null
    try {
      await deleteServiceEndpoint(fetch, data.projectId, data.endpoint.id)
      await goto(resolve(`/projects/${data.projectId}/service-endpoints`))
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete endpoint.'
    }
  }

  // AC-E6: recent health-check history, reverse-chronological, paginated (unlike the four list
  // endpoints above, this one does paginate — Background).
  let historyItems = $state<HealthHistoryEntry[]>([])
  let historyPage = $state(1)
  let historyHasNext = $state(false)
  let historyLoading = $state(false)
  let historyError = $state<string | null>(null)

  $effect(() => {
    if (data.endpoint) void loadHistory(1)
  })

  async function loadHistory(page: number) {
    if (!data.endpoint) return
    historyLoading = true
    historyError = null
    try {
      const result = await getHealthHistory(fetch, data.projectId, data.endpoint.id, { page })
      historyItems = page === 1 ? result.items : [...historyItems, ...result.items]
      historyHasNext = result.hasNext
      historyPage = page
    } catch (error) {
      historyError = error instanceof Error ? error.message : 'Could not load health history.'
    } finally {
      historyLoading = false
    }
  }

  // ADR-6.2-12: real diagnostic information, not collapsed into one generic "failed" label.
  function failureReasonLabel(reason: HealthHistoryFailureReason | null): string {
    if (!reason) return '—'
    switch (reason) {
      case 'ssrf_blocked':
        return 'Blocked (unsafe address)'
      case 'timeout':
        return 'Timed out'
      case 'http_error':
        return 'HTTP error'
      case 'network_error':
        return 'Network error'
    }
  }

  function formatDateTime(value: string): string {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }
</script>

<svelte:head>
  <title>{data.endpoint?.name ?? 'Endpoint'} | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  {#if data.notFound || !data.endpoint}
    <EntityNotFoundBanner
      title="Endpoint not found"
      message="This endpoint does not exist or you do not have access."
      backHref={`/projects/${data.projectId}/service-endpoints`}
      backLabel="Back to endpoints"
    />
  {:else}
    <DetailTitleCard
      eyebrow="Endpoint"
      title={data.endpoint.name}
      note={`Current URL: ${data.endpoint.url}`}
    />

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
          cancelHref={`/projects/${data.projectId}/service-endpoints`}
          submitting={form.submitting}
        />
      </AssetForm>
    {:else}
      <ReadOnlyPanel>
        <ReadOnlyField
          label="Check frequency"
          value={`Checked every ${data.endpoint.checkFrequencyMinutes} min`}
        />
        <ReadOnlyField
          label="Failure threshold"
          value={`Down after ${data.endpoint.downThresholdFailures} consecutive failures`}
        />
      </ReadOnlyPanel>
    {/if}

    {#if canManage}
      <AssetDeletePanel
        note="Deleting this endpoint will also resolve any active alerts for it."
        {deleteError}
        onDelete={handleDelete}
      />
    {/if}

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Recent health checks</h2>
      {#if historyError}
        <p class="mt-3 text-sm text-red-700" role="alert">{historyError}</p>
      {/if}
      {#if historyItems.length === 0 && !historyLoading}
        <p class="mt-3 text-sm text-slate-600">No health checks recorded yet.</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each historyItems as entry (entry.checkedAt + String(entry.statusCode))}
            <li
              class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <span>{formatDateTime(entry.checkedAt)}</span>
              <span>{entry.isHealthy ? 'Healthy' : 'Unhealthy'}</span>
              <span>{entry.statusCode ?? '—'}</span>
              <span>{entry.latencyMs} ms</span>
              <span>{failureReasonLabel(entry.failureReason)}</span>
            </li>
          {/each}
        </ul>
        {#if historyHasNext}
          <button
            class="mt-3 text-sm font-medium text-slate-700 underline"
            type="button"
            disabled={historyLoading}
            onclick={() => void loadHistory(historyPage + 1)}
          >
            Load more
          </button>
        {/if}
      {/if}
    </section>

    <BackLink href={`/projects/${data.projectId}/service-endpoints`} label="Back to endpoints" />
  {/if}
</section>
