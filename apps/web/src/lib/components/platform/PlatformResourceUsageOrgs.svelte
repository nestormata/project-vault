<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PlatformOrgsFigure from './PlatformOrgsFigure.svelte'
  import { pct } from './resource-usage-format.js'

  // Story 69.14: the organizations count card as one replaceable region.
  let {
    orgs,
    data,
  }: {
    orgs: { current: number; limit: number | null }
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.orgs -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-base font-semibold text-gray-900">Organizations</h2>
  <PlatformOrgsFigure
    text="{orgs.current} / {orgs.limit ?? 'No limit configured'}"
    pct={pct(orgs.current, orgs.limit)}
  /><InjectionPoint name="platform.settings-resource-usage.orgs" {data} />
</section>
