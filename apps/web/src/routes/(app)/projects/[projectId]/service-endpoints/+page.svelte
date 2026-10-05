<script lang="ts">
  import ServiceEndpointsListContent from '$lib/components/monitoring/ServiceEndpointsListContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import AssetListHeader from '$lib/components/monitoring/AssetListHeader.svelte'
  import { canManageMonitoredAssets } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))
</script>

<svelte:head>
  <title>Service endpoints | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.service-endpoints.before" data={data?.__inject} />
<InjectionPoint name="project.service-endpoints.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <AssetListHeader
    eyebrow="Endpoints"
    title="HTTP endpoint monitors"
    addHref={`/projects/${data.projectId}/service-endpoints/new`}
    addLabel="Add endpoint"
    {canManage}
  >
    Endpoints checked on a schedule; status feeds the org-wide health dashboard and public status
    page.
  </AssetListHeader>

  <!-- @region project.service-endpoints.list -->
  <ServiceEndpointsListContent {data} {canManage}>
    <InjectionPoint name="project.service-endpoints.list" data={data?.__inject} />
  </ServiceEndpointsListContent>
</section>
<InjectionPoint name="project.service-endpoints.after" data={data?.__inject} />
