<script lang="ts">
  import type { PublicStatusPage } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import StatusServiceList from '$lib/components/public/StatusServiceList.svelte'

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
  <StatusServiceList {statusPage} /><InjectionPoint
    name="status.detail.services"
    props={{ statusPage }}
    {data}
  />
</RegionFragment>
