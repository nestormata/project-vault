<script lang="ts">
  import HealthHeader from '$lib/components/monitoring/HealthHeader.svelte'
  import HealthProjects from '$lib/components/monitoring/HealthProjects.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()

  const hasAnyServices = $derived(data.dashboard.projects.length > 0)
</script>

<svelte:head>
  <title>Health | Project Vault</title>
</svelte:head>

<InjectionPoint name="health.home.before" data={data?.__inject} />
<InjectionPoint name="health.home.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region health.home.header -->
  <HealthHeader {hasAnyServices} summary={data.dashboard.summary}>
    <InjectionPoint name="health.home.header" data={data?.__inject} />
  </HealthHeader>

  <!-- @region health.home.projects -->
  <HealthProjects
    {hasAnyServices}
    projects={data.dashboard.projects}
    singleProjectId={data.singleProjectId}
  >
    <InjectionPoint name="health.home.projects" data={data?.__inject} />
  </HealthProjects>
</section>
<InjectionPoint name="health.home.after" data={data?.__inject} />
