<script lang="ts">
  import { resolve } from '$app/paths'

  let { data } = $props()
</script>

<svelte:head>
  <title>Credentials | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Credentials</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">Choose a project</h1>
      <p class="mt-2 text-slate-600">
        Credentials live inside projects — pick a project to manage secrets.
      </p>
    </div>
    <a
      class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
      href={resolve('/projects/new')}
    >
      Create project
    </a>
  </div>

  {#if data.projects.items.length === 0}
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
      <h2 class="text-xl font-semibold text-slate-950">No projects yet</h2>
      <p class="mt-2 text-slate-600">Create your first project to start managing credentials.</p>
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
          <dl class="mt-4 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt class="text-slate-500">Credentials</dt>
              <dd class="font-semibold">{project.credentialCount}</dd>
            </div>
            <div>
              <dt class="text-slate-500">Expiring</dt>
              <dd class="font-semibold">{project.expiringCount}</dd>
            </div>
            <div>
              <dt class="text-slate-500">Alerts</dt>
              <dd class="font-semibold">{project.alertCount}</dd>
            </div>
          </dl>
          <a
            class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
            href={resolve(`/projects/${project.id}/credentials`)}
          >
            Manage credentials
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
