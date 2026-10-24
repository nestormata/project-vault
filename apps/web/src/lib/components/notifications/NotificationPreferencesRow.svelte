<script lang="ts">
  import { enhance } from '$app/forms'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { NotificationSettingsPointProps } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { getEventTypeLabel } from '$lib/utils/event-type-labels.js'
  import type { PreferenceItem } from '$lib/api/notifications.js'

  // Story 69.12: one delivery preference row. Its point sits inside the actions cell's form (never
  // between table rows) and gets the viewer flags only, not the preference.
  let {
    pref,
    flagProps,
    data,
  }: {
    pref: PreferenceItem
    flagProps: NotificationSettingsPointProps
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.notifications.channels-row -->
<RegionFragment>
  <tr>
    <td class="px-6 py-4 text-sm font-medium text-gray-900">
      {getEventTypeLabel(pref.alertType)}
    </td>
    <td class="px-6 py-4 text-sm capitalize text-gray-500">{pref.channel}</td>
    <td class="px-6 py-4 text-sm text-gray-500">
      {pref.frequency === 'immediate' ? 'Immediate' : 'Daily digest'}
    </td>
    <td class="px-6 py-4 text-sm capitalize text-gray-500">{pref.minSeverity}+</td>
    <td class="px-6 py-4 text-sm">
      <form method="POST" action="?/updatePreference" use:enhance>
        <input type="hidden" name="alertType" value={pref.alertType} />
        <input type="hidden" name="channel" value={pref.channel} />
        <select
          name="frequency"
          class="mr-2 rounded border-gray-300 text-sm"
          aria-label={`Frequency for ${getEventTypeLabel(pref.alertType)} via ${pref.channel}`}
          aria-describedby="notification-frequency-help"
        >
          <option value="immediate" selected={pref.frequency === 'immediate'}>Immediate</option>
          <option value="digest_daily" selected={pref.frequency === 'digest_daily'}
            >Daily digest</option
          >
        </select>
        <FormHelpText id="notification-frequency-help" kind="select" />
        <select
          name="minSeverity"
          class="mr-2 rounded border-gray-300 text-sm"
          aria-label={`Minimum severity for ${getEventTypeLabel(pref.alertType)} via ${pref.channel}`}
          aria-describedby="notification-severity-help"
        >
          <option value="info" selected={pref.minSeverity === 'info'}>Info+</option>
          <option value="warning" selected={pref.minSeverity === 'warning'}>Warning+</option>
          <option value="critical" selected={pref.minSeverity === 'critical'}>Critical only</option>
        </select>
        <FormHelpText id="notification-severity-help" kind="select" />
        <button type="submit" class="text-sm font-medium text-indigo-600 hover:text-indigo-900"
          >Save</button
        ><InjectionPoint name="settings.notifications.channels-row" props={flagProps} {data} />
      </form>
    </td>
  </tr>
</RegionFragment>
