<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { deleteDomain, updateDomain } from '$lib/api/domains.js'
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

  let domainName = $state('')
  let renewalDate = $state('')
  let alertLeadDays = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ domainName?: string; renewalDate?: string }>({})
  let deleteError = $state<string | null>(null)

  // Reset the edit form whenever `data` changes (new load/navigation) — see services' detail page
  // for why: SvelteKit reuses this component instance across navigations to the same route shape.
  $effect(() => {
    domainName = data.domain?.domainName ?? ''
    renewalDate = toDateInputValue(data.domain?.renewalDate ?? null)
    alertLeadDays = (data.domain?.alertLeadDays ?? []).join(', ')
  })

  function validate(): { domainName?: string; renewalDate?: string } {
    const errors: { domainName?: string; renewalDate?: string } = {}
    if (!domainName.trim()) errors.domainName = 'Domain name is required'
    if (!renewalDate) errors.renewalDate = 'Renewal date is required'
    return errors
  }

  async function submitForm() {
    if (submitting || !canManage || !data.domain) return
    fieldErrors = validate()
    if (fieldErrors.domainName || fieldErrors.renewalDate) return

    submitting = true
    errorMessage = null
    try {
      const updated = await updateDomain(fetch, data.projectId, data.domain.id, {
        domainName: domainName.trim(),
        renewalDate: toIsoDate(renewalDate),
        alertLeadDays: parseAlertLeadDaysInput(alertLeadDays) ?? [],
      })
      data = { ...data, domain: updated }
      domainName = updated.domainName
      renewalDate = toDateInputValue(updated.renewalDate)
      alertLeadDays = updated.alertLeadDays.join(', ')
    } catch (error) {
      const mapped = mapMonitoringSubmitError(error, 'You do not have permission to edit domains.')
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
    }
  }

  async function handleDelete() {
    if (!data.domain) return
    deleteError = null
    try {
      await deleteDomain(fetch, data.projectId, data.domain.id)
      await goto(resolve(`/projects/${data.projectId}/domains`))
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete domain.'
    }
  }
</script>

<svelte:head>
  <title>{data.domain?.domainName ?? 'Domain'} | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  {#if data.notFound || !data.domain}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h1 class="text-xl font-semibold text-red-900">Domain not found</h1>
      <p class="mt-2 text-red-800">This domain does not exist or you do not have access.</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/domains`)}
      >
        Back to domains
      </a>
    </div>
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Domain</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.domain.domainName}</h1>
    </div>

    <form
      class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      onsubmit={(event) => {
        event.preventDefault()
        void submitForm()
      }}
    >
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="domain-name">Domain name</label>
        <input
          id="domain-name"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 disabled:bg-slate-50"
          type="text"
          bind:value={domainName}
          disabled={!canManage}
        />
        {#if fieldErrors.domainName}
          <p class="text-sm text-red-700">{fieldErrors.domainName}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="domain-renewal-date"
          >Renewal date</label
        >
        <input
          id="domain-renewal-date"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 disabled:bg-slate-50"
          type="date"
          bind:value={renewalDate}
          disabled={!canManage}
        />
        {#if fieldErrors.renewalDate}
          <p class="text-sm text-red-700">{fieldErrors.renewalDate}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="domain-alert-lead-days">
          Alert me before renewal (days, comma-separated)
        </label>
        <input
          id="domain-alert-lead-days"
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
          cancelHref={`/projects/${data.projectId}/domains`}
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
      href={resolve(`/projects/${data.projectId}/domains`)}
    >
      Back to domains
    </a>
  {/if}
</section>
