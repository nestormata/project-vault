<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { deleteDomain, updateDomain } from '$lib/api/domains.js'
  import {
    AssetDetailFooter,
    AssetForm,
    DetailTitleCard,
    DomainFormFields,
    DomainFormState,
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
    validateDomainFields,
  } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

  const form = new DomainFormState()
  let deleteError = $state<string | null>(null)

  // Reset the edit form whenever `data` changes (new load/navigation) — see services' detail page
  // for why: SvelteKit reuses this component instance across navigations to the same route shape.
  $effect(() => {
    form.domainName = data.domain?.domainName ?? ''
    form.renewalDate = toDateInputValue(data.domain?.renewalDate ?? null)
    form.alertLeadDays = (data.domain?.alertLeadDays ?? []).join(', ')
  })

  async function submitForm() {
    if (form.submitting || !canManage || !data.domain) return
    form.fieldErrors = validateDomainFields(form.domainName, form.renewalDate)
    if (form.fieldErrors.domainName || form.fieldErrors.renewalDate) return

    form.submitting = true
    form.errorMessage = null
    try {
      // Code-review finding: a blank alert-lead-days field must omit the key (leaving the
      // server's current value untouched on this partial PATCH) rather than sending an explicit
      // `[]`, which would silently disable renewal alerting — the same "blank omits the field"
      // semantics the create form already uses (see form-helpers.ts's parseAlertLeadDaysInput).
      const parsedAlertLeadDays = parseAlertLeadDaysInput(form.alertLeadDays)
      const updated = await updateDomain(fetch, data.projectId, data.domain.id, {
        domainName: form.domainName.trim(),
        renewalDate: toIsoDate(form.renewalDate),
        ...(parsedAlertLeadDays !== undefined ? { alertLeadDays: parsedAlertLeadDays } : {}),
      })
      data = { ...data, domain: updated }
      form.domainName = updated.domainName
      form.renewalDate = toDateInputValue(updated.renewalDate)
      form.alertLeadDays = updated.alertLeadDays.join(', ')
    } catch (error) {
      const mapped = mapMonitoringSubmitError(error, 'You do not have permission to edit domains.')
      form.fieldErrors = mapped.fieldErrors
      form.errorMessage = mapped.errorMessage
    } finally {
      form.submitting = false
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
    <EntityNotFoundBanner
      title="Domain not found"
      message="This domain does not exist or you do not have access."
      backHref={`/projects/${data.projectId}/domains`}
      backLabel="Back to domains"
    />
  {:else}
    <DetailTitleCard eyebrow="Domain" title={data.domain.domainName} />

    {#if canManage}
      <AssetForm onsubmit={submitForm}>
        <DomainFormFields
          bind:domainName={form.domainName}
          bind:renewalDate={form.renewalDate}
          bind:alertLeadDays={form.alertLeadDays}
          fieldErrors={form.fieldErrors}
        />

        <SaveChangesFooter
          errorMessage={form.errorMessage}
          cancelHref={`/projects/${data.projectId}/domains`}
          submitting={form.submitting}
        />
      </AssetForm>
    {:else}
      <ReadOnlyPanel>
        <ReadOnlyField label="Domain name" value={data.domain.domainName} />
        <ReadOnlyField label="Renewal date" value={formatDate(data.domain.renewalDate)} />
        <ReadOnlyField
          label="Alert lead days"
          value={formatAlertLeadDays(data.domain.alertLeadDays)}
        />
      </ReadOnlyPanel>
    {/if}

    <AssetDetailFooter
      {canManage}
      {deleteError}
      onDelete={handleDelete}
      backHref={`/projects/${data.projectId}/domains`}
      backLabel="Back to domains"
    />
  {/if}
</section>
