<script lang="ts">
  import type { PublicStatusPageService } from '@project-vault/shared'

  let { data } = $props()

  function statusClass(status: PublicStatusPageService['status']): string {
    switch (status) {
      case 'healthy':
        return 'bg-emerald-100 text-emerald-800'
      case 'degraded':
        return 'bg-amber-100 text-amber-900'
      case 'down':
        return 'bg-red-100 text-red-800'
    }
  }

  function formatCheckedAt(value: string | null): string {
    if (!value) return 'Not checked yet'
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }
</script>

<svelte:head>
  <title>Status | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 py-10">
  {#if data.statusPage}
    <h1 class="text-2xl font-bold text-slate-950">Service status</h1>
    {#if data.statusPage.services.length === 0}
      <p class="mt-4 text-slate-600">No services are currently listed on this status page.</p>
    {:else}
      <ul class="mt-6 space-y-3">
        {#each data.statusPage.services as service, index (index)}
          <li
            class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
          >
            <div class="min-w-0">
              <p class="truncate font-medium text-slate-900">{service.displayName}</p>
              <p class="text-xs text-slate-500">{formatCheckedAt(service.lastCheckedAt)}</p>
            </div>
            <span
              class={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${statusClass(service.status)}`}
            >
              {service.status}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <h1 class="text-2xl font-bold text-slate-950">Status page not available</h1>
    <p class="mt-3 text-slate-600">
      This link is invalid, has been disabled, or is temporarily unavailable.
    </p>
  {/if}
</div>
