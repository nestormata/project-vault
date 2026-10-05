<script lang="ts">
  import ProjectsNewHeader from '$lib/components/projects/ProjectsNewHeader.svelte'
  import ProjectsNewForm from '$lib/components/projects/ProjectsNewForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
</script>

<svelte:head>
  <title>Create Project | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.new.before" data={data?.__inject} />
<InjectionPoint name="project.new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.new.header -->
  <ProjectsNewHeader>
    <InjectionPoint name="project.new.header" data={data?.__inject} />
  </ProjectsNewHeader>

  <!-- @region project.new.form -->
  <ProjectsNewForm>
    <InjectionPoint name="project.new.form" data={data?.__inject} />
  </ProjectsNewForm>
</section>
<InjectionPoint name="project.new.after" data={data?.__inject} />
