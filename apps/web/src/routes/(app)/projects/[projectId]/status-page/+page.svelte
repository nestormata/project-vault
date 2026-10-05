<script lang="ts">
  import StatusPageSettingsHeader from '$lib/components/monitoring/StatusPageSettingsHeader.svelte'
  import StatusPageSettingsContent from '$lib/components/monitoring/StatusPageSettingsContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Public status page | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.status-page.before" data={data?.__inject} />
<InjectionPoint name="project.status-page.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region project.status-page.header -->
  <StatusPageSettingsHeader>
    <InjectionPoint name="project.status-page.header" data={data?.__inject} />
  </StatusPageSettingsHeader>

  <!-- @region project.status-page.settings -->
  <StatusPageSettingsContent {data}>
    <InjectionPoint name="project.status-page.settings" data={data?.__inject} />
  </StatusPageSettingsContent>
</section>
<InjectionPoint name="project.status-page.after" data={data?.__inject} />
