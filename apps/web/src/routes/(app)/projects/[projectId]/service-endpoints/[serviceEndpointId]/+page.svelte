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
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { mapMonitoringSubmitError } from '$lib/monitoring/form-errors.js'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  // AC-E4: unlike services/certificates/domains, the endpoint edit form diffs against the loaded
  // values and PATCHes only what actually changed. `url` in particular starts blank (a fresh
  // entry) rather than pre-filled with the already-redacted display value — Background explicitly
  // forbids trying to "restore" or edit around the redaction.
  let name = $state('')
  let url = $state('')
  let checkFrequencyMinutes = $state(5)
  let downThresholdFailures = $state(2)
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ name?: string }>({})
  let deleteError = $state<string | null>(null)

  $effect(() => {
    name = data.endpoint?.name ?? ''
    url = ''
    checkFrequencyMinutes = data.endpoint?.checkFrequencyMinutes ?? 5
    downThresholdFailures = data.endpoint?.downThresholdFailures ?? 2
  })

  async function submitForm() {
    if (submitting || !canManage || !data.endpoint) return
    fieldErrors = name.trim() ? {} : { name: 'Name is required' }
    if (fieldErrors.name) return

    const changes: {
      name?: string
      url?: string
      checkFrequencyMinutes?: number
      downThresholdFailures?: number
    } = {}
    if (name.trim() !== data.endpoint.name) changes.name = name.trim()
    if (url.trim()) changes.url = url.trim()
    if (checkFrequencyMinutes !== data.endpoint.checkFrequencyMinutes) {
      changes.checkFrequencyMinutes = checkFrequencyMinutes
    }
    if (downThresholdFailures !== data.endpoint.downThresholdFailures) {
      changes.downThresholdFailures = downThresholdFailures
    }
    if (Object.keys(changes).length === 0) return

    submitting = true
    errorMessage = null
    try {
      const updated = await updateServiceEndpoint(fetch, data.projectId, data.endpoint.id, changes)
      data = { ...data, endpoint: updated }
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to edit service endpoints.'
      )
      fieldErrors = mapped.fieldErrors as { name?: string }
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
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
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h1 class="text-xl font-semibold text-red-900">Endpoint not found</h1>
      <p class="mt-2 text-red-800">This endpoint does not exist or you do not have access.</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/service-endpoints`)}
      >
        Back to endpoints
      </a>
    </div>
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Endpoint</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.endpoint.name}</h1>
      <p class="mt-2 text-sm text-slate-600">Current URL: {data.endpoint.url}</p>
    </div>

    {#if canManage}
      <form
        class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
        onsubmit={(event) => {
          event.preventDefault()
          void submitForm()
        }}
      >
        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="endpoint-name">Name</label>
          <input
            id="endpoint-name"
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            type="text"
            bind:value={name}
          />
          {#if fieldErrors.name}
            <p class="text-sm text-red-700">{fieldErrors.name}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="endpoint-url">
            New URL (leave blank to keep current)
          </label>
          <input
            id="endpoint-url"
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            type="text"
            placeholder="https://api.example.com/health"
            bind:value={url}
          />
        </div>

        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="endpoint-frequency">
            Check frequency (minutes)
          </label>
          <select
            id="endpoint-frequency"
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            bind:value={checkFrequencyMinutes}
          >
            {#each CHECK_FREQUENCY_MINUTES as minutes (minutes)}
              <option value={minutes}>{minutes}</option>
            {/each}
          </select>
        </div>

        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="endpoint-threshold">
            Failures before "down" (1-10)
          </label>
          <input
            id="endpoint-threshold"
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            type="number"
            min="1"
            max="10"
            bind:value={downThresholdFailures}
          />
        </div>

        {#if errorMessage}
          <p
            class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            role="alert"
          >
            {errorMessage}
          </p>
        {/if}

        <FormSubmitRow
          submitLabel="Save changes"
          pendingLabel="Saving…"
          cancelHref={`/projects/${data.projectId}/service-endpoints`}
          {submitting}
        />
      </form>
    {:else}
      <!-- AC-I1/code-review finding: a viewer must not see a disabled-but-visible mutation form
           (which invites a stale-role 403 on click) — show a plain read-only view instead. -->
      <div class="space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <p class="text-sm font-medium text-slate-900">Check frequency</p>
          <p class="text-slate-700">Checked every {data.endpoint.checkFrequencyMinutes} min</p>
        </div>
        <div>
          <p class="text-sm font-medium text-slate-900">Failure threshold</p>
          <p class="text-slate-700">
            Down after {data.endpoint.downThresholdFailures} consecutive failures
          </p>
        </div>
      </div>
    {/if}

    {#if canManage}
      <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p class="mb-3 text-sm text-slate-600">
          Deleting this endpoint will also resolve any active alerts for it.
        </p>
        {#if deleteError}
          <p class="mb-3 text-sm text-red-700" role="alert">{deleteError}</p>
        {/if}
        <ConfirmDeleteButton onConfirm={handleDelete} />
      </div>
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

    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/service-endpoints`)}
    >
      Back to endpoints
    </a>
  {/if}
</section>
