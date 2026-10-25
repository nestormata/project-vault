<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import CredentialsProjectList from './CredentialsProjectList.svelte'
  import CreateProjectEmptyState from './CreateProjectEmptyState.svelte'

  let {
    canImport,
    projects,
    children,
  }: { canImport: boolean; projects: ProjectListPage['items']; children?: Snippet } = $props()
</script>

{@render children?.()}
{#if !canImport}
  <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
    <h2 class="text-lg font-semibold text-red-900">Import not available</h2>
    <p class="mt-2 text-red-800">
      Bulk import requires Admin or Owner access. Ask your administrator to upgrade your role.
    </p>
  </div>
{:else if projects.length === 0}
  <CreateProjectEmptyState message="Create a project before importing secrets." />
{:else}
  <CredentialsProjectList {projects}>
    {#snippet card(project)}
      <a
        class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
        href={resolve(`/projects/${project.id}/credentials/import`)}
      >
        Import into this project
      </a>
    {/snippet}
  </CredentialsProjectList>
{/if}
