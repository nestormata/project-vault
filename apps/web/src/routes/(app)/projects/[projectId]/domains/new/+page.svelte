<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { createDomain } from '$lib/api/domains.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import {
    AssetForm,
    DomainFormFields,
    DomainFormState,
    FormErrorBanner,
  } from '$lib/components/monitoring/index.js'
  import {
    canManageMonitoredAssets,
    mapMonitoringSubmitError,
    parseAlertLeadDaysInput,
    toIsoDate,
    validateDomainFields,
  } from '$lib/monitoring/index.js'

  let { data } = $props()

  const form = new DomainFormState()

  const canCreate = $derived(canManageMonitoredAssets(data.orgRole))

  async function submitForm() {
    if (form.submitting || !canCreate) return
    form.fieldErrors = validateDomainFields(form.domainName, form.renewalDate)
    if (form.fieldErrors.domainName || form.fieldErrors.renewalDate) return

    form.submitting = true
    form.errorMessage = null
    try {
      const body: { domainName: string; renewalDate: string; alertLeadDays?: number[] } = {
        domainName: form.domainName.trim(),
        renewalDate: toIsoDate(form.renewalDate),
      }
      const parsedLeadDays = parseAlertLeadDaysInput(form.alertLeadDays)
      if (parsedLeadDays) body.alertLeadDays = parsedLeadDays

      const created = await createDomain(fetch, data.projectId, body)
      await goto(resolve(`/projects/${data.projectId}/domains/${created.id}`))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to create domains.'
      )
      form.fieldErrors = mapped.fieldErrors
      form.errorMessage = mapped.errorMessage
    } finally {
      form.submitting = false
    }
  }
</script>

<svelte:head>
  <title>New domain | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New domain</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Add domain</h1>
  </div>

  {#if !canCreate}
    <AccessNotice
      title="Create not available"
      message="Domain creation requires Member access or higher. Ask your administrator to upgrade your role."
      backHref={`/projects/${data.projectId}/domains`}
      backLabel="Back to domains"
    />
  {:else}
    <AssetForm onsubmit={submitForm}>
      <DomainFormFields
        bind:domainName={form.domainName}
        bind:renewalDate={form.renewalDate}
        bind:alertLeadDays={form.alertLeadDays}
        fieldErrors={form.fieldErrors}
        alertLeadDaysPlaceholder="30"
      />

      <FormErrorBanner message={form.errorMessage} />

      <FormSubmitRow
        submitLabel="Create domain"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/domains`}
        submitting={form.submitting}
      />
    </AssetForm>
  {/if}
</section>
