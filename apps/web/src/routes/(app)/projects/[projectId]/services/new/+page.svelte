<script lang="ts">
  import ServicesNewHeader from '$lib/components/monitoring/ServicesNewHeader.svelte'
  import ServicesNewForm from '$lib/components/monitoring/ServicesNewForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>New service | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.services-new.before" data={data?.__inject} />
<InjectionPoint name="project.services-new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.services-new.header -->
  <ServicesNewHeader>
    <InjectionPoint name="project.services-new.header" data={data?.__inject} />
  </ServicesNewHeader>

  <!-- @region project.services-new.form -->
  <ServicesNewForm {data}>
    <InjectionPoint name="project.services-new.form" data={data?.__inject} />
  </ServicesNewForm>
</section>
<InjectionPoint name="project.services-new.after" data={data?.__inject} />
