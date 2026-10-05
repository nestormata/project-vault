<script lang="ts">
  import ProjectsImportHeader from '$lib/components/projects/ProjectsImportHeader.svelte'
  import ProjectsImportContent from '$lib/components/projects/ProjectsImportContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
</script>

<svelte:head>
  <title>Import project | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.import.before" data={data?.__inject} />
<InjectionPoint name="project.import.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.import.header -->
  <ProjectsImportHeader>
    <InjectionPoint name="project.import.header" data={data?.__inject} />
  </ProjectsImportHeader>

  <!-- @region project.import.content -->
  <ProjectsImportContent>
    <InjectionPoint name="project.import.content" data={data?.__inject} />
  </ProjectsImportContent>
</section>
<InjectionPoint name="project.import.after" data={data?.__inject} />
