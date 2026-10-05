<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/domains/new/$types.js'
  import type { Snippet } from 'svelte'
  import {
    canManageMonitoredAssets,
    mapMonitoringSubmitError,
    parseAlertLeadDaysInput,
    toIsoDate,
    validateDomainFields,
  } from '$lib/monitoring/index.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { createDomain } from '$lib/api/domains.js'
  import {
    AssetForm,
    DomainFormFields,
    DomainFormState,
    FormErrorBanner,
  } from '$lib/components/monitoring/index.js'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'

  let { data, children }: { data: PageData; children?: Snippet } = $props()

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

{@render children?.()}
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
