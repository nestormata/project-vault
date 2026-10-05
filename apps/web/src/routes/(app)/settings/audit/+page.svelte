<script lang="ts">
  import AuditNavigationLinks from '$lib/components/audit/AuditNavigationLinks.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import AuditExportPanel from '$lib/components/audit/AuditExportPanel.svelte'
  import AuditVerifyPanel from '$lib/components/audit/AuditVerifyPanel.svelte'
  import AuditPageHeader from '$lib/components/audit/AuditPageHeader.svelte'
  import AuditRoleNotice from '$lib/components/audit/AuditRoleNotice.svelte'
  import AuditErrorBanner from '$lib/components/audit/AuditErrorBanner.svelte'
  import AuditSearchForm from '$lib/components/audit/AuditSearchForm.svelte'
  import AuditResultsTable from '$lib/components/audit/AuditResultsTable.svelte'

  let { data } = $props()

  const hasFilters = $derived(
    data.allowed && data.filters && Object.values(data.filters).some((value) => Boolean(value))
  )

  // Story 69.4: the ungated regions get the viewer's role and whether PV let them in, nothing else.
  const roleProps = $derived({ orgRole: data.orgRole, allowed: data.allowed })
</script>

<svelte:head>
  <title>Audit Log | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.audit.before" data={data?.__inject} />
<InjectionPoint name="settings.audit.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-5xl px-4 py-8">
  <!-- @region settings.audit.header -->
  <AuditPageHeader>
    <InjectionPoint name="settings.audit.header" props={roleProps} data={data?.__inject} />
  </AuditPageHeader>{#if !data.allowed}
    <!-- @region settings.audit.notice -->
    <AuditRoleNotice orgRole={data.orgRole}>
      <InjectionPoint name="settings.audit.notice" props={roleProps} data={data?.__inject} />
    </AuditRoleNotice>
  {:else}
    {@const resultsProps = {
      orgRole: data.orgRole,
      allowed: data.allowed,
      filters: data.filters,
      events: data.events,
      page: data.page,
      total: data.total,
      hasNext: data.hasNext,
      errorMessage: data.errorMessage,
    }}
    <!-- @region settings.audit.navigation -->
    <div class="mt-6 flex flex-wrap gap-4 text-sm">
      <AuditNavigationLinks /><InjectionPoint
        name="settings.audit.navigation"
        props={roleProps}
        data={data?.__inject}
      />
    </div>

    <!-- @region settings.audit.error -->
    <AuditErrorBanner message={data.errorMessage}>
      <InjectionPoint name="settings.audit.error" props={resultsProps} data={data?.__inject} />
    </AuditErrorBanner>

    <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <!-- @region settings.audit.search -->
      <AuditSearchForm filters={data.filters} hasFilters={Boolean(hasFilters)}>
        <InjectionPoint name="settings.audit.search" props={resultsProps} data={data?.__inject} />
      </AuditSearchForm><!-- @region settings.audit.results --><AuditResultsTable
        events={data.events}
        filters={data.filters}
        hasFilters={Boolean(hasFilters)}
        page={data.page}
        total={data.total}
        hasNext={data.hasNext}
      >
        <InjectionPoint name="settings.audit.results" props={resultsProps} data={data?.__inject} />
      </AuditResultsTable>
    </div>

    <!-- @region settings.audit.export -->
    <div class="mt-6">
      <AuditExportPanel /><InjectionPoint
        name="settings.audit.export"
        props={roleProps}
        data={data?.__inject}
      />
    </div>
    <!-- @region settings.audit.verify -->
    <div class="mt-6">
      <AuditVerifyPanel /><InjectionPoint
        name="settings.audit.verify"
        props={roleProps}
        data={data?.__inject}
      />
    </div>
  {/if}
</div>
<InjectionPoint name="settings.audit.after" data={data?.__inject} />
