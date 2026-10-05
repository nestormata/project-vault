<script lang="ts">
  import ServiceEndpointDetailContent from '$lib/components/monitoring/ServiceEndpointDetailContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{data.endpoint?.name ?? 'Endpoint'} | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.service-endpoints-detail.before" data={data?.__inject} />
<InjectionPoint name="project.service-endpoints-detail.header.actions" data={data?.__inject} />
<!-- @region project.service-endpoints-detail.content -->
<ServiceEndpointDetailContent {data}>
  <InjectionPoint name="project.service-endpoints-detail.content" data={data?.__inject} />
</ServiceEndpointDetailContent>
<InjectionPoint name="project.service-endpoints-detail.after" data={data?.__inject} />
