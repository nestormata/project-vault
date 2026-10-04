<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import PublicStatusUnavailableText from './PublicStatusUnavailableText.svelte'

  // Story 69.3: the "Status page not available" state as one replaceable region. It renders for an
  // invalid, disabled or sealed token and no contribution load ran for it (the page's own load marks
  // that result `skipInjectedLoads`), so its `data` is always null. A contribution at
  // `status.detail.unavailable` receives the standard props only.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region status.detail.unavailable -->
<RegionFragment>
  <PublicStatusUnavailableText /><InjectionPoint name="status.detail.unavailable" {data} />
</RegionFragment>
