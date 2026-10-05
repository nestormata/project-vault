<script lang="ts">
  import type { PublicStatusPage } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import ServiceStatusItem from '$lib/components/dashboard/ServiceStatusItem.svelte'

  // Story 69.3: the list of services (or its empty state) of a valid public status page as one
  // replaceable region. A contribution at `status.detail.services` receives `{ statusPage }`
  // (public-safe by construction: the token is never part of it) and renders right after the list.
  // Its `load` runs only for a valid token and, like everything here, without `locals.user`.
  let {
    statusPage,
    data,
  }: {
    statusPage: PublicStatusPage
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region status.detail.services -->
<RegionFragment>
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
  {/if}<InjectionPoint name="status.detail.services" props={{ statusPage }} {data} />
</RegionFragment>
