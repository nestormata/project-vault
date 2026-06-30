<script lang="ts">
  import { resolve } from '$app/paths'

  let { data } = $props()
</script>

<svelte:head>
  <title>Import credentials | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Bulk import</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Import credentials</h1>
    <p class="mt-2 text-slate-600">Choose a project to upload a .env or JSON file.</p>
  </div>

  {#if !data.canImport}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <h2 class="text-lg font-semibold text-red-900">Import not available</h2>
      <p class="mt-2 text-red-800">
        Bulk import requires Admin or Owner access. Ask your administrator to upgrade your role.
      </p>
    </div>
  {:else if data.projects.items.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <p class="text-slate-600">Create a project before importing credentials.</p>
      <a
        class="mt-4 inline-block font-medium text-slate-950 underline"
        href={resolve('/projects/new')}
      >
        Create project
      </a>
    </div>
  {:else}
    <ul class="grid gap-4 md:grid-cols-2">
      {#each data.projects.items as project (project.id)}
        <li class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 class="text-xl font-semibold text-slate-950">{project.name}</h2>
          <p class="mt-1 text-sm text-slate-500">{project.slug}</p>
          <a
            class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
            href={resolve(`/projects/${project.id}/credentials/import`)}
          >
            Import into this project
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
