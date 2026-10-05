<script lang="ts">
  import ServiceEndpointsNewHeader from '$lib/components/monitoring/ServiceEndpointsNewHeader.svelte'
  import ServiceEndpointsNewForm from '$lib/components/monitoring/ServiceEndpointsNewForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>New endpoint | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.service-endpoints-new.before" data={data?.__inject} />
<InjectionPoint name="project.service-endpoints-new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.service-endpoints-new.header -->
  <ServiceEndpointsNewHeader>
    <InjectionPoint name="project.service-endpoints-new.header" data={data?.__inject} />
  </ServiceEndpointsNewHeader>

  <!-- @region project.service-endpoints-new.form -->
  <ServiceEndpointsNewForm {data}>
    <InjectionPoint name="project.service-endpoints-new.form" data={data?.__inject} />
  </ServiceEndpointsNewForm>
</section>
<InjectionPoint name="project.service-endpoints-new.after" data={data?.__inject} />
