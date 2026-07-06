<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { CHECK_FREQUENCY_MINUTES, createServiceEndpoint } from '$lib/api/service-endpoints.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { mapMonitoringSubmitError } from '$lib/monitoring/form-errors.js'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'

  let { data } = $props()

  let name = $state('')
  let url = $state('')
  let checkFrequencyMinutes = $state(5)
  let downThresholdFailures = $state(2)
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ name?: string; url?: string }>({})

  const canCreate = $derived(canManageMonitoredAssets(data.orgRole))

  function validate(): { name?: string; url?: string } {
    const errors: { name?: string; url?: string } = {}
    if (!name.trim()) errors.name = 'Name is required'
    if (!url.trim()) errors.url = 'URL is required'
    return errors
  }

  async function submitForm() {
    if (submitting || !canCreate) return
    fieldErrors = validate()
    if (fieldErrors.name || fieldErrors.url) return

    submitting = true
    errorMessage = null
    try {
      const created = await createServiceEndpoint(fetch, data.projectId, {
        name: name.trim(),
        url: url.trim(),
        checkFrequencyMinutes,
        downThresholdFailures,
      })
      await goto(resolve(`/projects/${data.projectId}/service-endpoints/${created.id}`))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to create service endpoints.'
      )
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
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
        <label class="block font-medium text-slate-900" for="endpoint-url">URL</label>
        <input
          id="endpoint-url"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          placeholder="https://api.example.com/health"
          bind:value={url}
        />
        {#if fieldErrors.url}
          <p class="text-sm text-red-700">{fieldErrors.url}</p>
        {/if}
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
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}

      <FormSubmitRow
        submitLabel="Create endpoint"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/service-endpoints`}
        {submitting}
      />
    </form>
  {/if}
</section>
