<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { deleteService, updateService } from '$lib/api/services.js'
  import {
    AssetDetailFooter,
    AssetForm,
    DetailTitleCard,
    EntityNotFoundBanner,
    FieldInput,
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
  } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))

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
    <EntityNotFoundBanner
      title="Service not found"
      message="This service does not exist or you do not have access."
      backHref={`/projects/${data.projectId}/services`}
      backLabel="Back to services"
    />
  {:else}
    <DetailTitleCard
      eyebrow="Service"
      title={data.service.name}
      note="Renaming a service isn't supported — create a new one instead if the name needs to change."
    />

    {#if canManage}
      <AssetForm onsubmit={submitForm}>
        <FieldInput id="service-url" label="URL" bind:value={url} />
        <FieldInput
          id="service-renewal-date"
          label="Renewal date"
          type="date"
          bind:value={renewalDate}
        />
        <FieldInput
          id="service-alert-lead-days"
          label="Alert me before renewal (days, comma-separated)"
          bind:value={alertLeadDays}
        />

        <SaveChangesFooter
          {errorMessage}
          cancelHref={`/projects/${data.projectId}/services`}
          {submitting}
        />
      </AssetForm>
    {:else}
      <ReadOnlyPanel>
        <ReadOnlyField label="URL" value={data.service.url ?? '—'} />
        <ReadOnlyField label="Renewal date" value={formatDate(data.service.renewalDate)} />
        <ReadOnlyField
          label="Alert lead days"
          value={formatAlertLeadDays(data.service.alertLeadDays)}
        />
      </ReadOnlyPanel>
    {/if}

    <AssetDetailFooter
      {canManage}
      {deleteError}
      onDelete={handleDelete}
      backHref={`/projects/${data.projectId}/services`}
      backLabel="Back to services"
    />
  {/if}
</section>
