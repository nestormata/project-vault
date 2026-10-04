<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ProjectExportPanel from '$lib/components/projects/ProjectExportPanel.svelte'
  import ProjectNotFound from '$lib/components/projects/ProjectNotFound.svelte'
  import ProjectStatTiles from '$lib/components/projects/ProjectStatTiles.svelte'
  import ProjectSummaryCard from '$lib/components/projects/ProjectSummaryCard.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{data.project ? `${data.project.name} | Project Vault` : 'Project | Project Vault'}</title>
</svelte:head>

<InjectionPoint
  name="project.detail.before"
  props={{ project: data.project }}
  data={data.__inject}
/>
<InjectionPoint
  name="project.detail.header.actions"
  props={{ project: data.project }}
  data={data.__inject}
/>
{#if data.notFound || !data.project}
  <ProjectNotFound data={data.__inject} />
{:else}
  {@const project = data.project}
  {@const dashboard = data.dashboard}
  <section class="space-y-6">
    <ProjectSummaryCard {project} data={data.__inject} />
    <ProjectExportPanel {project} data={data.__inject} />
    {#if dashboard}
      <ProjectStatTiles {project} {dashboard} data={data.__inject} />
    {/if}
  </section>
{/if}
<InjectionPoint
  name="project.detail.after"
  props={{ project: data.project }}
  data={data.__inject}
/>
