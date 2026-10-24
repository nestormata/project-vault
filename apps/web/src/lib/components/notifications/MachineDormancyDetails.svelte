<script lang="ts">
  import type { DormancyAlertView } from '$lib/notifications/dormancy-alerts.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.12: what a machine key dormancy alert says (which machine user and key, when the key was
  // last used). The point renders once per alert, after the details. The card puts the actions row
  // right after it, with no whitespace of its own, because the space before this point is the one
  // that separated the details from the row.
  let {
    alert,
    data,
  }: { alert: DormancyAlertView; data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region notifications.home.machine-dormancy-details -->
<RegionFragment>
  <p class="text-sm font-semibold text-gray-900">
    {alert.machineUserName} — key "{alert.keyName}"
  </p>
  <p class="mt-1 text-sm text-gray-600">
    Last used: {alert.lastUsedAt ? new Date(alert.lastUsedAt).toLocaleDateString() : 'never'}
  </p>
  <InjectionPoint name="notifications.home.machine-dormancy-details" {data} />
</RegionFragment>
