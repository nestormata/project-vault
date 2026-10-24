<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'

  // Story 69.12: the column heads of the preference table. The point sits inside the last head
  // cell: a contribution can never land between table rows.
  let {
    flagProps,
    data,
  }: {
    flagProps: InjectionPointExtras<'settings.notifications.header'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.notifications.channels-head -->
<RegionFragment>
  <thead class="bg-gray-50">
    <tr>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Alert Type</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Channel</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Frequency</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Min Severity</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500"
        >Actions<InjectionPoint
          name="settings.notifications.channels-head"
          props={flagProps}
          {data}
        /></th
      >
    </tr>
  </thead>
</RegionFragment>
