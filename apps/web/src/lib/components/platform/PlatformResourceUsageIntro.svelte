<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import PlatformWarningsBanner from '$lib/components/platform/PlatformWarningsBanner.svelte'
  import { WARNING_MESSAGES } from './resource-usage-format.js'

  // Story 69.14: the resource usage heading, its subtitle and the instance warnings as one
  // replaceable region.
  let {
    warnings,
    data,
  }: {
    warnings: string[]
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.intro -->
<RegionFragment>
  <h1 class="text-2xl font-bold text-gray-900">Resource Usage</h1>
  <p class="mt-1 text-gray-500">Monitor instance-wide resource consumption and limits.</p>

  <PlatformWarningsBanner {warnings} messages={WARNING_MESSAGES} /><InjectionPoint
    name="platform.settings-resource-usage.intro"
    {data}
  />
</RegionFragment>
