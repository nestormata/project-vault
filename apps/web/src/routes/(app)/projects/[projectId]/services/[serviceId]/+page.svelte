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

  function formatDate(value: string | null): string {
    if (!value) return '—'
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  function formatAlertLeadDays(days: number[]): string {
    if (days.length === 0) return '—'
    return `Alerts at ${days.join(', ')} days before`
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
      // Code-review finding: a blank alert-lead-days field must omit the key (leaving the
      // server's current value untouched on this partial PATCH) rather than sending an explicit
      // `[]`, which would silently disable renewal alerting — the same "blank omits the field"
      // semantics the create form already uses (see form-helpers.ts's parseAlertLeadDaysInput).
      const parsedAlertLeadDays = parseAlertLeadDaysInput(alertLeadDays)
      const updated = await updateService(fetch, data.projectId, data.service.id, {
        url: url.trim() ? url.trim() : null,
        renewalDate: renewalDate ? toIsoDate(renewalDate) : null,
        ...(parsedAlertLeadDays !== undefined ? { alertLeadDays: parsedAlertLeadDays } : {}),
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

    {#if canManage}
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
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            type="text"
            bind:value={url}
          />
        </div>

        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="service-renewal-date"
            >Renewal date</label
          >
          <input
            id="service-renewal-date"
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            type="date"
            bind:value={renewalDate}
          />
        </div>

        <div class="space-y-2">
          <label class="block font-medium text-slate-900" for="service-alert-lead-days">
            Alert me before renewal (days, comma-separated)
          </label>
          <input
            id="service-alert-lead-days"
            class="w-full rounded-xl border border-slate-300 px-3 py-3"
            type="text"
            bind:value={alertLeadDays}
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
          cancelHref={`/projects/${data.projectId}/services`}
          {submitting}
        />
      </form>
    {:else}
      <!-- AC-I1/code-review finding: a viewer must not see a disabled-but-visible mutation form
           (which invites a stale-role 403 on click) — show a plain read-only view instead. -->
      <div class="space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <p class="text-sm font-medium text-slate-900">URL</p>
          <p class="text-slate-700">{data.service.url ?? '—'}</p>
        </div>
        <div>
          <p class="text-sm font-medium text-slate-900">Renewal date</p>
          <p class="text-slate-700">{formatDate(data.service.renewalDate)}</p>
        </div>
        <div>
          <p class="text-sm font-medium text-slate-900">Alert lead days</p>
          <p class="text-slate-700">{formatAlertLeadDays(data.service.alertLeadDays)}</p>
        </div>
      </div>
    {/if}

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
