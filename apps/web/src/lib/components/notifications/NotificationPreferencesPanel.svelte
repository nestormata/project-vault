<script lang="ts">
  import { enhance } from '$app/forms'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { getEventTypeLabel } from '$lib/utils/event-type-labels.js'
  import type { PreferenceItem } from '$lib/api/notifications.js'

  // Story 69.4: the body of the "Personal Delivery Preferences" card (heading and the per-row
  // preference table). The page keeps the card element and renders its
  // `settings.notifications.channels` point after this.
  let { preferences }: { preferences: readonly PreferenceItem[] } = $props()
</script>

<div class="border-b border-gray-200 px-6 py-4">
  <h2 class="text-lg font-semibold text-gray-800">Personal Delivery Preferences</h2>
  <p class="mt-1 text-sm text-gray-500">
    Per-org settings. Changes here only affect your account in this organization.
  </p>
</div>

<table class="min-w-full divide-y divide-gray-200">
  <thead class="bg-gray-50">
    <tr>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Alert Type</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Channel</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Frequency</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Min Severity</th>
      <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
    </tr>
  </thead>
  <tbody class="divide-y divide-gray-200 bg-white">
    {#each preferences as pref (pref.alertType + ':' + pref.channel)}
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
              <option value="critical" selected={pref.minSeverity === 'critical'}
                >Critical only</option
              >
            </select>
            <FormHelpText id="notification-severity-help" kind="select" />
            <button type="submit" class="text-sm font-medium text-indigo-600 hover:text-indigo-900"
              >Save</button
            >
          </form>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
