<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { deleteCertificate, updateCertificate } from '$lib/api/certificates.js'
  import {
    AssetDetailFooter,
    AssetForm,
    CertificateFormFields,
    CertificateFormState,
    DetailTitleCard,
    EntityNotFoundBanner,
    ReadOnlyField,
    ReadOnlyPanel,
    SaveChangesFooter,
  } from '$lib/components/monitoring/index.js'
  import {
    canManageMonitoredAssets,
    formatAlertLeadDays,
    formatDate,
    mapMonitoringSubmitError,
    parseAlertLeadDaysInput,
    toDateInputValue,
    toIsoDate,
    validateCertificateFields,
  } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  const form = new CertificateFormState()
  let deleteError = $state<string | null>(null)

  // Reset the edit form whenever `data` changes (new load/navigation) — see services' detail page
  // for why: SvelteKit reuses this component instance across navigations to the same route shape.
  $effect(() => {
    form.domain = data.certificate?.domain ?? ''
    form.expiresAt = toDateInputValue(data.certificate?.expiresAt ?? null)
    form.alertLeadDays = (data.certificate?.alertLeadDays ?? []).join(', ')
  })

  async function submitForm() {
    if (form.submitting || !canManage || !data.certificate) return
    form.fieldErrors = validateCertificateFields(form.domain, form.expiresAt)
    if (form.fieldErrors.domain || form.fieldErrors.expiresAt) return

    form.submitting = true
    form.errorMessage = null
    try {
      // Code-review finding: a blank alert-lead-days field must omit the key (leaving the
      // server's current value untouched on this partial PATCH) rather than sending an explicit
      // `[]`, which would silently disable expiry alerting — the same "blank omits the field"
      // semantics the create form already uses (see form-helpers.ts's parseAlertLeadDaysInput).
      const parsedAlertLeadDays = parseAlertLeadDaysInput(form.alertLeadDays)
      const updated = await updateCertificate(fetch, data.projectId, data.certificate.id, {
        domain: form.domain.trim(),
        expiresAt: toIsoDate(form.expiresAt),
        ...(parsedAlertLeadDays !== undefined ? { alertLeadDays: parsedAlertLeadDays } : {}),
      })
      data = { ...data, certificate: updated }
      form.domain = updated.domain
      form.expiresAt = toDateInputValue(updated.expiresAt)
      form.alertLeadDays = updated.alertLeadDays.join(', ')
    } catch (error) {
      const mapped = mapMonitoringSubmitError(
        error,
        'You do not have permission to edit certificates.'
      )
      form.fieldErrors = mapped.fieldErrors
      form.errorMessage = mapped.errorMessage
    } finally {
      form.submitting = false
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
    <EntityNotFoundBanner
      title="Certificate not found"
      message="This certificate does not exist or you do not have access."
      backHref={`/projects/${data.projectId}/certificates`}
      backLabel="Back to certificates"
    />
  {:else}
    <DetailTitleCard eyebrow="Certificate" title={data.certificate.domain} />

    {#if canManage}
      <AssetForm onsubmit={submitForm}>
        <CertificateFormFields
          bind:domain={form.domain}
          bind:expiresAt={form.expiresAt}
          bind:alertLeadDays={form.alertLeadDays}
          fieldErrors={form.fieldErrors}
        />

        <SaveChangesFooter
          errorMessage={form.errorMessage}
          cancelHref={`/projects/${data.projectId}/certificates`}
          submitting={form.submitting}
        />
      </AssetForm>
    {:else}
      <ReadOnlyPanel>
        <ReadOnlyField label="Domain" value={data.certificate.domain} />
        <ReadOnlyField label="Expires on" value={formatDate(data.certificate.expiresAt)} />
        <ReadOnlyField
          label="Alert lead days"
          value={formatAlertLeadDays(data.certificate.alertLeadDays)}
        />
      </ReadOnlyPanel>
    {/if}

    <AssetDetailFooter
      {canManage}
      {deleteError}
      onDelete={handleDelete}
      backHref={`/projects/${data.projectId}/certificates`}
      backLabel="Back to certificates"
    />
  {/if}
</section>
