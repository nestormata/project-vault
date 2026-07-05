<script lang="ts">
  import ServiceStatusItem from '$lib/components/dashboard/ServiceStatusItem.svelte'

  let { data } = $props()
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
            <ServiceStatusItem
              name={service.displayName}
              status={service.status}
              lastCheckedAt={service.lastCheckedAt}
            />
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
