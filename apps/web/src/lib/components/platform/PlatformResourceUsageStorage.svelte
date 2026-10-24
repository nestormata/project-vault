<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import PlatformUsageMeter from './PlatformUsageMeter.svelte'
  import { pct } from './resource-usage-format.js'

  // Story 69.14: the storage bytes card as one replaceable region.
  let {
    storageBytes,
    data,
  }: {
    storageBytes: { current: number; limit: number | null }
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.storage -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-base font-semibold text-gray-900">Storage</h2>
  <PlatformUsageMeter
    text="{formatBytes(storageBytes.current)} / {storageBytes.limit !== null
      ? formatBytes(storageBytes.limit)
      : 'No limit configured'}"
    pct={pct(storageBytes.current, storageBytes.limit)}
  /><InjectionPoint name="platform.settings-resource-usage.storage" {data} />
</section>
