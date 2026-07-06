<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { deleteService, updateService } from '$lib/api/services.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { mapMonitoringSubmitError } from '$lib/monitoring/form-errors.js'
  import { parseAlertLeadDaysInput, toIsoDate } from '$lib/monitoring/form-helpers.js'
  import { canManageMonitoredAssets } from '$lib/monitoring/permissions.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  function toDateInputValue(value: string | null): string {
    if (!value) return ''
    return value.slice(0, 10)
  }

  let url = $state('')
  let renewalDate = $state('')
  let alertLeadDays = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let deleteError = $state<string | null>(null)

  // Reset the edit form whenever `data` changes (new load/navigation) — SvelteKit reuses this
  // component instance across navigations to the same route shape (e.g. one service's edit page
  // to another's), so initializing $state directly from `data.service` would otherwise only
  // capture the first-mounted service's values and go stale (adversarial review finding).
  $effect(() => {
    url = data.service?.url ?? ''
    renewalDate = toDateInputValue(data.service?.renewalDate ?? null)
    alertLeadDays = (data.service?.alertLeadDays ?? []).join(', ')
  })

  async function submitForm() {
    if (submitting || !canManage || !data.service) return
    submitting = true
    errorMessage = null
    try {
      const updated = await updateService(fetch, data.projectId, data.service.id, {
        url: url.trim() ? url.trim() : null,
        renewalDate: renewalDate ? toIsoDate(renewalDate) : null,
        alertLeadDays: parseAlertLeadDaysInput(alertLeadDays) ?? [],
      })
      data = { ...data, service: updated }
      url = updated.url ?? ''
      renewalDate = toDateInputValue(updated.renewalDate)
      alertLeadDays = updated.alertLeadDays.join(', ')
    } catch (error) {
      const mapped = mapMonitoringSubmitError(error, 'You do not have permission to edit services.')
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
    }
  }

  async function handleDelete() {
    if (!data.service) return
    deleteError = null
    try {
      await deleteService(fetch, data.projectId, data.service.id)
      await goto(resolve(`/projects/${data.projectId}/services`))
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete service.'
    }
  }
</script>

<svelte:head>
  <title>{data.service?.name ?? 'Service'} | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  {#if data.notFound || !data.service}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h1 class="text-xl font-semibold text-red-900">Service not found</h1>
      <p class="mt-2 text-red-800">This service does not exist or you do not have access.</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/services`)}
      >
        Back to services
      </a>
    </div>
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Service</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.service.name}</h1>
      <p class="mt-2 text-sm text-slate-500">
        Renaming a service isn't supported — create a new one instead if the name needs to change.
      </p>
    </div>

    <form
      class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      onsubmit={(event) => {
        event.preventDefault()
        void submitForm()
      }}
    >
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="service-url">URL</label>
        <input
          id="service-url"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 disabled:bg-slate-50"
          type="text"
          bind:value={url}
          disabled={!canManage}
        />
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="service-renewal-date"
          >Renewal date</label
        >
        <input
          id="service-renewal-date"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 disabled:bg-slate-50"
          type="date"
          bind:value={renewalDate}
          disabled={!canManage}
        />
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="service-alert-lead-days">
          Alert me before renewal (days, comma-separated)
        </label>
        <input
          id="service-alert-lead-days"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 disabled:bg-slate-50"
          type="text"
          bind:value={alertLeadDays}
          disabled={!canManage}
        />
      </div>

      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}

      {#if canManage}
        <FormSubmitRow
          submitLabel="Save changes"
          pendingLabel="Saving…"
          cancelHref={`/projects/${data.projectId}/services`}
          {submitting}
        />
      {/if}
    </form>

    {#if canManage}
      <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {#if deleteError}
          <p class="mb-3 text-sm text-red-700" role="alert">{deleteError}</p>
        {/if}
        <ConfirmDeleteButton onConfirm={handleDelete} />
      </div>
    {/if}

    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/services`)}
    >
      Back to services
    </a>
  {/if}
</section>
