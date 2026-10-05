<script lang="ts">
  import DomainsNewHeader from '$lib/components/monitoring/DomainsNewHeader.svelte'
  import DomainsNewForm from '$lib/components/monitoring/DomainsNewForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>New domain | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.domains-new.before" data={data?.__inject} />
<InjectionPoint name="project.domains-new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.domains-new.header -->
  <DomainsNewHeader>
    <InjectionPoint name="project.domains-new.header" data={data?.__inject} />
  </DomainsNewHeader>

  <!-- @region project.domains-new.form -->
  <DomainsNewForm {data}>
    <InjectionPoint name="project.domains-new.form" data={data?.__inject} />
  </DomainsNewForm>
</section>
<InjectionPoint name="project.domains-new.after" data={data?.__inject} />
