<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import CredentialsProjectList from './CredentialsProjectList.svelte'
  import ProjectCounts from '$lib/components/projects/ProjectCounts.svelte'
  import CreateProjectEmptyState from './CreateProjectEmptyState.svelte'

  let { projects, children }: { projects: ProjectListPage['items']; children?: Snippet } = $props()
</script>

{@render children?.()}
{#if projects.length === 0}
  <CreateProjectEmptyState
    title="No projects yet"
    message="Create your first project to start managing secrets."
  />
{:else}
  <CredentialsProjectList {projects}>
    {#snippet card(project)}
      <ProjectCounts {project} />
      <a
        class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
        href={resolve(`/projects/${project.id}/credentials`)}
      >
        Manage secrets
      </a>
    {/snippet}
  </CredentialsProjectList>
{/if}
