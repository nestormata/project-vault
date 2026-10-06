<script lang="ts">
  import CertificatesListContent from '$lib/components/monitoring/CertificatesListContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import AssetListHeaderRegion from '$lib/components/monitoring/AssetListHeaderRegion.svelte'
  import { canManageMonitoredAssets } from '$lib/monitoring/index.js'

  let { data } = $props()

  const canManage = $derived(canManageMonitoredAssets(data.orgRole))
</script>

<svelte:head>
  <title>Certificates | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.certificates.before" data={data?.__inject} />
<InjectionPoint name="project.certificates.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region project.certificates.list-header -->
  <AssetListHeaderRegion
    eyebrow="Certificates"
    title="SSL/TLS certificates"
    addHref={`/projects/${data.projectId}/certificates/new`}
    addLabel="Add certificate"
    {canManage}
    description="Certificates tracked for expiry alerting."
  >
    <InjectionPoint name="project.certificates.list-header" data={data?.__inject} />
  </AssetListHeaderRegion>

  <!-- @region project.certificates.list -->
  <CertificatesListContent {data} {canManage}>
    <InjectionPoint name="project.certificates.list" data={data?.__inject} />
  </CertificatesListContent>
</section>
<InjectionPoint name="project.certificates.after" data={data?.__inject} />
