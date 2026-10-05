<script lang="ts">
  import AccessReportHeader from '$lib/components/settings/AccessReportHeader.svelte'
  import AccessReportPanel from '$lib/components/settings/AccessReportPanel.svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Access Report | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.audit-access-report.before" data={data?.__inject} />
<InjectionPoint name="settings.audit-access-report.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-5xl px-4 py-8">
  <!-- @region settings.audit-access-report.header -->
  <AccessReportHeader>
    <InjectionPoint name="settings.audit-access-report.header" data={data?.__inject} />
  </AccessReportHeader>
  <NavLink
    surface="back"
    node="back.settings.audit.access-report"
    class="mt-2 inline-block text-sm text-indigo-600 underline"
  />

  <!-- @region settings.audit-access-report.report -->
  <AccessReportPanel {data}>
    <InjectionPoint name="settings.audit-access-report.report" data={data?.__inject} />
  </AccessReportPanel>
</div>
<InjectionPoint name="settings.audit-access-report.after" data={data?.__inject} />
