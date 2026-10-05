<script lang="ts">
  import ServiceDetailContent from '$lib/components/monitoring/ServiceDetailContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{data.service?.name ?? 'Service'} | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.services-detail.before" data={data?.__inject} />
<InjectionPoint name="project.services-detail.header.actions" data={data?.__inject} />
<!-- @region project.services-detail.content -->
<ServiceDetailContent {data}>
  <InjectionPoint name="project.services-detail.content" data={data?.__inject} />
</ServiceDetailContent>
<InjectionPoint name="project.services-detail.after" data={data?.__inject} />
