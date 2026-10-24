<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { PreferenceItem } from '$lib/api/notifications.js'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import NotificationPreferencesHead from './NotificationPreferencesHead.svelte'
  import NotificationPreferencesHeader from './NotificationPreferencesHeader.svelte'
  import NotificationPreferencesRow from './NotificationPreferencesRow.svelte'

  // Story 69.4: the body of the "Personal Delivery Preferences" card (heading and the per-row
  // preference table). The page keeps the card element and renders its
  // `settings.notifications.channels` point after this.
  // Story 69.12: the heading, the column heads and each row are sub-regions that get the viewer
  // flags only. `data` is the page's `__inject` map.
  let {
    preferences,
    flagProps,
    data,
  }: {
    preferences: readonly PreferenceItem[]
    flagProps: InjectionPointExtras<'settings.notifications.header'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.notifications.channels-header -->
<RegionFragment>
  <NotificationPreferencesHeader /><InjectionPoint
    name="settings.notifications.channels-header"
    props={flagProps}
    {data}
  />
</RegionFragment>

<table class="min-w-full divide-y divide-gray-200">
  <NotificationPreferencesHead {flagProps} {data} />
  <tbody class="divide-y divide-gray-200 bg-white">
    {#each preferences as pref (pref.alertType + ':' + pref.channel)}
      <NotificationPreferencesRow {pref} {flagProps} {data} />
    {/each}
  </tbody>
</table>
