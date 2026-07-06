<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { deleteCertificate, updateCertificate } from '$lib/api/certificates.js'
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

  let domain = $state('')
  let expiresAt = $state('')
  let alertLeadDays = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ domain?: string; expiresAt?: string }>({})
  let deleteError = $state<string | null>(null)

  // Reset the edit form whenever `data` changes (new load/navigation) — see services' detail page
  // for why: SvelteKit reuses this component instance across navigations to the same route shape.
  $effect(() => {
    domain = data.certificate?.domain ?? ''
    expiresAt = toDateInputValue(data.certificate?.expiresAt ?? null)
    alertLeadDays = (data.certificate?.alertLeadDays ?? []).join(', ')
  })

  function validate(): { domain?: string; expiresAt?: string } {
    const errors: { domain?: string; expiresAt?: string } = {}
    if (!domain.trim()) errors.domain = 'Domain is required'
    if (!expiresAt) errors.expiresAt = 'Expiry date is required'
    return errors
  }

  async function submitForm() {
    if (submitting || !canManage || !data.certificate) return
    fieldErrors = validate()
    if (fieldErrors.domain || fieldErrors.expiresAt) return

    submitting = true
    errorMessage = null
    try {
      const updated = await updateCertificate(fetch, data.projectId, data.certificate.id, {
        domain: domain.trim(),
        expiresAt: toIsoDate(expiresAt),
        alertLeadDays: parseAlertLeadDaysInput(alertLeadDays) ?? [],
      })
      data = { ...data, certificate: updated }
      domain = updated.domain
      expiresAt = toDateInputValue(updated.expiresAt)
      alertLeadDays = updated.alertLeadDays.join(', ')
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to edit certificates.'
      )
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
    } finally {
      submitting = false
    }
  }

  async function handleDelete() {
    if (!data.certificate) return
    deleteError = null
    try {
      await deleteCertificate(fetch, data.projectId, data.certificate.id)
      await goto(resolve(`/projects/${data.projectId}/certificates`))
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete certificate.'
    }
  }
</script>

<svelte:head>
  <title>{data.certificate?.domain ?? 'Certificate'} | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  {#if data.notFound || !data.certificate}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h1 class="text-xl font-semibold text-red-900">Certificate not found</h1>
      <p class="mt-2 text-red-800">This certificate does not exist or you do not have access.</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve(`/projects/${data.projectId}/certificates`)}
      >
        Back to certificates
      </a>
    </div>
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Certificate</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.certificate.domain}</h1>
    </div>

    <form
      class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      onsubmit={(event) => {
        event.preventDefault()
        void submitForm()
      }}
    >
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="certificate-domain">Domain</label>
        <input
          id="certificate-domain"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 disabled:bg-slate-50"
          type="text"
          bind:value={domain}
          disabled={!canManage}
        />
        {#if fieldErrors.domain}
          <p class="text-sm text-red-700">{fieldErrors.domain}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="certificate-expires-at"
          >Expiry date</label
        >
        <input
          id="certificate-expires-at"
          class="w-full rounded-xl border border-slate-300 px-3 py-3 disabled:bg-slate-50"
          type="date"
          bind:value={expiresAt}
          disabled={!canManage}
        />
        {#if fieldErrors.expiresAt}
          <p class="text-sm text-red-700">{fieldErrors.expiresAt}</p>
        {/if}
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="certificate-alert-lead-days">
          Alert me before expiry (days, comma-separated)
        </label>
        <input
          id="certificate-alert-lead-days"
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
          cancelHref={`/projects/${data.projectId}/certificates`}
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
      href={resolve(`/projects/${data.projectId}/certificates`)}
    >
      Back to certificates
    </a>
  {/if}
</section>
