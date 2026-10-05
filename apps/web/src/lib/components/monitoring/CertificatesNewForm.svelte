<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/certificates/new/$types.js'
  import type { Snippet } from 'svelte'
  import {
    canManageMonitoredAssets,
    mapMonitoringSubmitError,
    parseAlertLeadDaysInput,
    toIsoDate,
    validateCertificateFields,
  } from '$lib/monitoring/index.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { createCertificate } from '$lib/api/certificates.js'
  import {
    AssetForm,
    CertificateFormFields,
    CertificateFormState,
    FormErrorBanner,
  } from '$lib/components/monitoring/index.js'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'

  let { data, children }: { data: PageData; children?: Snippet } = $props()

  const form = new CertificateFormState()
  const canCreate = $derived(canManageMonitoredAssets(data.orgRole))
  async function submitForm() {
    if (form.submitting || !canCreate) return
    form.fieldErrors = validateCertificateFields(form.domain, form.expiresAt, {
      maxDomainLength: 253,
    })
    if (form.fieldErrors.domain || form.fieldErrors.expiresAt) return

    form.submitting = true
    form.errorMessage = null
    try {
      const body: { domain: string; expiresAt: string; alertLeadDays?: number[] } = {
        domain: form.domain.trim(),
        expiresAt: toIsoDate(form.expiresAt),
      }
      const parsedLeadDays = parseAlertLeadDaysInput(form.alertLeadDays)
      if (parsedLeadDays) body.alertLeadDays = parsedLeadDays

      const created = await createCertificate(fetch, data.projectId, body)
      await goto(resolve(`/projects/${data.projectId}/certificates/${created.id}`))
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to create certificates.'
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
    message="Certificate creation requires Member access or higher. Ask your administrator to upgrade your role."
    backHref={`/projects/${data.projectId}/certificates`}
    backLabel="Back to certificates"
  />
{:else}
  <AssetForm onsubmit={submitForm}>
    <CertificateFormFields
      bind:domain={form.domain}
      bind:expiresAt={form.expiresAt}
      bind:alertLeadDays={form.alertLeadDays}
      fieldErrors={form.fieldErrors}
      alertLeadDaysPlaceholder="30, 7"
    />

    <FormErrorBanner message={form.errorMessage} />

    <FormSubmitRow
      submitLabel="Create certificate"
      pendingLabel="Creating…"
      cancelHref={`/projects/${data.projectId}/certificates`}
      submitting={form.submitting}
    />
  </AssetForm>
{/if}
