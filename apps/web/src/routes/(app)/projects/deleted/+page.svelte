<script lang="ts">
  import DeletedProjectsHeader from '$lib/components/projects/DeletedProjectsHeader.svelte'
  import DeletedProjectsList from '$lib/components/projects/DeletedProjectsList.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Deleted projects | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.deleted.before" data={data.__inject} />
<InjectionPoint name="project.deleted.header.actions" data={data.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.deleted.header -->
  <DeletedProjectsHeader>
    <InjectionPoint name="project.deleted.header" data={data.__inject} />
  </DeletedProjectsHeader>

  <!-- @region project.deleted.list -->
  <DeletedProjectsList projects={data.deleted}>
    <InjectionPoint name="project.deleted.list" data={data.__inject} />
  </DeletedProjectsList>
</section>
<InjectionPoint name="project.deleted.after" data={data.__inject} />
