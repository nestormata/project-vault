<script lang="ts">
  import DomainsListContent from '$lib/components/monitoring/DomainsListContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import AssetListHeaderRegion from '$lib/components/monitoring/AssetListHeaderRegion.svelte'
  import { canManageMonitoredAssets } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))
</script>

<svelte:head>
  <title>Domains | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.domains.before" data={data?.__inject} />
<InjectionPoint name="project.domains.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region project.domains.list-header -->
  <AssetListHeaderRegion
    eyebrow="Domains"
    title="Domain registrations"
    addHref={`/projects/${data.projectId}/domains/new`}
    addLabel="Add domain"
    {canManage}
    description="Domains tracked for renewal alerting."
  >
    <InjectionPoint name="project.domains.list-header" data={data?.__inject} />
  </AssetListHeaderRegion>

  <!-- @region project.domains.list -->
  <DomainsListContent {data} {canManage}>
    <InjectionPoint name="project.domains.list" data={data?.__inject} />
  </DomainsListContent>
</section>
<InjectionPoint name="project.domains.after" data={data?.__inject} />
