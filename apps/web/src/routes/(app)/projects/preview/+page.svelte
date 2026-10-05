<script lang="ts">
  import ProjectPreviewContent from '$lib/components/projects/ProjectPreviewContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
</script>

<svelte:head>
  <title>Preview Project | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.preview.before" data={data?.__inject} />
<InjectionPoint name="project.preview.header.actions" data={data?.__inject} />
<!-- @region project.preview.content -->
<ProjectPreviewContent>
  <InjectionPoint name="project.preview.content" data={data?.__inject} />
</ProjectPreviewContent>
<InjectionPoint name="project.preview.after" data={data?.__inject} />
