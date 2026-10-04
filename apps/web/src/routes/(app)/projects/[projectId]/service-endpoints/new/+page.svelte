<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ServiceEndpointCreateForm from '$lib/components/monitoring/ServiceEndpointCreateForm.svelte'
  import ServiceEndpointNewHeader from '$lib/components/monitoring/ServiceEndpointNewHeader.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>New endpoint | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.service-endpoints-new.before" data={data?.__inject} />
<InjectionPoint name="project.service-endpoints-new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <ServiceEndpointNewHeader project={data.project} orgRole={data.orgRole} data={data.__inject} />

  <ServiceEndpointCreateForm
    project={data.project}
    orgRole={data.orgRole}
    projectId={data.projectId}
    data={data.__inject}
  />
</section>
<InjectionPoint name="project.service-endpoints-new.after" data={data?.__inject} />
