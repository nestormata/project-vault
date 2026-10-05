<script lang="ts">
  import ServicesListContent from '$lib/components/monitoring/ServicesListContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import AssetListHeader from '$lib/components/monitoring/AssetListHeader.svelte'
  import { canManageMonitoredAssets } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))
</script>

<svelte:head>
  <title>Services | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.services.before" data={data?.__inject} />
<InjectionPoint name="project.services.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <AssetListHeader
    eyebrow="Services"
    title="Monitored services"
    addHref={`/projects/${data.projectId}/services/new`}
    addLabel="Add service"
    {canManage}
  >
    Billing/hosting services tracked for renewal alerting.
  </AssetListHeader>

  <!-- @region project.services.list -->
  <ServicesListContent {data} {canManage}>
    <InjectionPoint name="project.services.list" data={data?.__inject} />
  </ServicesListContent>
</section>
<InjectionPoint name="project.services.after" data={data?.__inject} />
