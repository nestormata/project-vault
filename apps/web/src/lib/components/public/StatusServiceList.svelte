<script lang="ts">
  import type { PublicStatusPage } from '@project-vault/shared'
  import ServiceStatusItem from '$lib/components/dashboard/ServiceStatusItem.svelte'

  // The services of a public status page, or its empty state. Shared by the page body and the
  // `status.detail.services` region so the two cannot drift.
  let { statusPage }: { statusPage: PublicStatusPage } = $props()
</script>

{#if statusPage.services.length === 0}
  <p class="mt-4 text-slate-600">No services are currently listed on this status page.</p>
{:else}
  <ul class="mt-6 space-y-3">
    {#each statusPage.services as service, index (index)}
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
