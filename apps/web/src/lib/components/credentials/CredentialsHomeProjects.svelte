<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'

  let { projects, children }: { projects: ProjectListPage['items']; children?: Snippet } = $props()
</script>

{@render children?.()}
{#if projects.length === 0}
  <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
    <h2 class="text-xl font-semibold text-slate-950">No projects yet</h2>
    <p class="mt-2 text-slate-600">Create your first project to start managing secrets.</p>
    <a
      class="mt-4 inline-block font-medium text-slate-950 underline"
      href={resolve('/projects/new')}
    >
      Create project
    </a>
  </div>
{:else}
  <ul class="grid gap-4 md:grid-cols-2">
    {#each projects as project (project.id)}
      <li class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 class="text-xl font-semibold text-slate-950">{project.name}</h2>
        <p class="mt-1 text-sm text-slate-500">{project.slug}</p>
        <dl class="mt-4 grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt class="text-slate-500">Secrets</dt>
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
          Manage secrets
        </a>
      </li>
    {/each}
  </ul>
{/if}
