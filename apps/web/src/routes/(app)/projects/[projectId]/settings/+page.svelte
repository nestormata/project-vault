<script lang="ts">
  import { PROJECT_DELETE_GRACE_DAYS } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ProjectDeleteZone from '$lib/components/projects/ProjectDeleteZone.svelte'
  import ProjectSettingsNotFound from '$lib/components/projects/ProjectSettingsNotFound.svelte'
  import ProjectSettingsForm from '$lib/components/projects/ProjectSettingsForm.svelte'
  import ProjectSettingsHeader from '$lib/components/projects/ProjectSettingsHeader.svelte'
  import { canArchiveInProject } from '$lib/projects/project-write-access.js'

  let { data } = $props()

  // The same rule as the API (project owner or org owner); it only decides which controls show.
  const canManage = $derived(canArchiveInProject(data.orgRole, data.project))
</script>

<svelte:head>
  <title
    >{data.project
      ? `Settings: ${data.project.name} | Project Vault`
      : 'Project settings | Project Vault'}</title
  >
</svelte:head>

<InjectionPoint name="project.settings.before" data={data.__inject} />
<InjectionPoint name="project.settings.header.actions" data={data.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  {#if data.notFound || !data.project}
    <!-- @region project.settings.not-found -->
    <ProjectSettingsNotFound>
      <InjectionPoint name="project.settings.not-found" data={data.__inject} />
    </ProjectSettingsNotFound>
  {:else}
    {@const project = data.project}
    <!-- @region project.settings.header -->
    <ProjectSettingsHeader projectId={project.id} name={project.name}>
      <InjectionPoint name="project.settings.header" data={data.__inject} />
    </ProjectSettingsHeader>

    {#if canManage}
      <!-- @region project.settings.form -->
      <ProjectSettingsForm {project}>
        <InjectionPoint name="project.settings.form" data={data.__inject} />
      </ProjectSettingsForm>

      <!-- @region project.settings.delete -->
      <ProjectDeleteZone {project} graceDays={PROJECT_DELETE_GRACE_DAYS}>
        <InjectionPoint name="project.settings.delete" data={data.__inject} />
      </ProjectDeleteZone>
    {:else}
      <p class="rounded-3xl border border-slate-200 bg-white p-6 text-slate-700 shadow-sm">
        Only the project owner or an organization owner can edit or delete this project.
      </p>
    {/if}
  {/if}
</section>
<InjectionPoint name="project.settings.after" data={data.__inject} />
