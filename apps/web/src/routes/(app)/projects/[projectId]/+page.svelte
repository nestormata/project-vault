<script lang="ts">
  let { data } = $props()

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
</script>

<svelte:head>
  <title>{data.project ? `${data.project.name} | Project Vault` : 'Project | Project Vault'}</title>
</svelte:head>

{#if data.notFound || !data.project}
  <section class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
    <h1 class="text-xl font-semibold text-slate-950">Project not found</h1>
    <p class="mt-2 text-slate-600">This project doesn't exist, or you don't have access to it.</p>
  </section>
{:else}
  {@const project = data.project}
  {@const dashboard = data.dashboard}
  <section class="space-y-6">
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-3xl font-bold text-slate-950">{project.name}</h1>
        {#if project.archivedAt}
          <span class="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700">
            Archived
          </span>
        {/if}
      </div>
      {#if project.description}
        <p class="mt-2 text-slate-600">{project.description}</p>
      {/if}
      {#if project.tags.length > 0}
        <ul class="mt-3 flex flex-wrap gap-2">
          {#each project.tags as tag (tag)}
            <li class="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
              {tag}
            </li>
          {/each}
        </ul>
      {/if}
      <p class="mt-3 text-sm text-slate-500">
        Created {formatDate(project.createdAt)} · Your role: {project.role}
      </p>
    </div>

    {#if dashboard}
      <dl class="grid gap-4 sm:grid-cols-3">
        <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <dt class="text-sm text-slate-500">Members</dt>
          <dd class="mt-1 text-2xl font-bold text-slate-950">
            {project.memberCount}
            {project.memberCount === 1 ? 'member' : 'members'}
          </dd>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <dt class="text-sm text-slate-500">Expiring soon (30 days)</dt>
          <dd class="mt-1 text-2xl font-bold text-slate-950">
            {#if dashboard.credentialStats.expiringSoon > 0}
              {dashboard.credentialStats.expiringSoon} expiring soon
            {:else}
              Nothing expiring soon
            {/if}
          </dd>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <dt class="text-sm text-slate-500">Service health</dt>
          <dd class="mt-1 text-2xl font-bold text-slate-950">
            {#if dashboard.monitoredServiceHealth.healthy + dashboard.monitoredServiceHealth.degraded + dashboard.monitoredServiceHealth.down === 0}
              No services configured yet
            {:else}
              {dashboard.monitoredServiceHealth.healthy} healthy ·
              {dashboard.monitoredServiceHealth.degraded} degraded ·
              {dashboard.monitoredServiceHealth.down} down
            {/if}
          </dd>
        </div>
      </dl>
    {/if}
  </section>
{/if}
