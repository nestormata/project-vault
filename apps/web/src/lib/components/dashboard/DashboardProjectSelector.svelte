<script lang="ts">
  import { resolve } from '$app/paths'

  type DashboardProject = {
    id: string
    name: string
  }

  let {
    projects,
    selectedProject,
  }: {
    projects?: { items?: DashboardProject[] }
    selectedProject: DashboardProject
  } = $props()
</script>

{#if (projects?.items?.length ?? 0) > 1}
  <form
    method="GET"
    action={resolve('/dashboard')}
    class="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end"
  >
    <div class="flex-1">
      <label class="block text-sm font-semibold text-slate-700" for="dashboard-project">
        Dashboard project
      </label>
      <select
        id="dashboard-project"
        name="projectId"
        class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
        value={selectedProject.id}
      >
        {#each projects?.items ?? [] as project (project.id)}
          <option value={project.id}>{project.name}</option>
        {/each}
      </select>
    </div>
    <button
      type="submit"
      class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
    >
      View project
    </button>
  </form>
{/if}
