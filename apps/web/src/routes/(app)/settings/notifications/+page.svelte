<script lang="ts">
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import type { PageData } from './$types.js'

  const { data }: { data: PageData } = $props()

  const ALERT_TYPE_LABELS: Record<string, string> = {
    'security.failed_auth_threshold': 'Failed Login Threshold',
    'credential.expiry': 'Credential Expiry',
    'service.down': 'Service Down',
    'service.recovery': 'Service Recovery',
    'rotation.stale': 'Stale Rotation',
    'backup.failure': 'Backup Failure',
    'machine_key.expiry': 'Machine Key Expiry',
    'security.anomalous_access': 'Anomalous Access',
    'machine_cache.activated': 'Offline Cache Activated',
  }
</script>

<svelte:head>
  <title>Notification Preferences | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-4xl px-4 py-8">
  <div class="mb-8">
    <a href={resolve('/settings')} class="text-sm text-indigo-600 hover:text-indigo-800"
      >← Settings</a
    >
    <h1 class="mt-2 text-2xl font-bold text-gray-900">Notification Preferences</h1>
    <p class="text-gray-500">Configure how and when you receive alerts from Project Vault.</p>
  </div>

  <div class="mb-8 overflow-hidden rounded-lg bg-white shadow">
    <div class="border-b border-gray-200 px-6 py-4">
      <h2 class="text-lg font-semibold text-gray-800">Personal Delivery Preferences</h2>
      <p class="mt-1 text-sm text-gray-500">
        Per-org settings. Changes here only affect your account in this organization.
      </p>
    </div>

    <table class="min-w-full divide-y divide-gray-200">
      <thead class="bg-gray-50">
        <tr>
          <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Alert Type</th
          >
          <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Channel</th>
          <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Frequency</th>
          <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500"
            >Min Severity</th
          >
          <th class="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200 bg-white">
        {#each data.preferences as pref (pref.alertType + ':' + pref.channel)}
          <tr>
            <td class="px-6 py-4 text-sm font-medium text-gray-900">
              {ALERT_TYPE_LABELS[pref.alertType] ?? pref.alertType}
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
                <select name="frequency" class="mr-2 rounded border-gray-300 text-sm">
                  <option value="immediate" selected={pref.frequency === 'immediate'}
                    >Immediate</option
                  >
                  <option value="digest_daily" selected={pref.frequency === 'digest_daily'}
                    >Daily digest</option
                  >
                </select>
                <select name="minSeverity" class="mr-2 rounded border-gray-300 text-sm">
                  <option value="info" selected={pref.minSeverity === 'info'}>Info+</option>
                  <option value="warning" selected={pref.minSeverity === 'warning'}>Warning+</option
                  >
                  <option value="critical" selected={pref.minSeverity === 'critical'}
                    >Critical only</option
                  >
                </select>
                <button
                  type="submit"
                  class="text-sm font-medium text-indigo-600 hover:text-indigo-900">Save</button
                >
              </form>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if data.isAdmin && data.routing}
    <div class="overflow-hidden rounded-lg bg-white shadow">
      <div class="border-b border-gray-200 px-6 py-4">
        <h2 class="text-lg font-semibold text-gray-800">Org-Level Routing</h2>
        <p class="mt-1 text-sm text-gray-500">
          Configure which role receives each alert type (admin only).
        </p>
      </div>
      <div class="px-6 py-4">
        <form method="POST" action="?/updateRouting" use:enhance>
          {#each data.routing as route (route.alertType)}
            <div class="mb-3 flex items-center gap-4">
              <span class="w-64 text-sm text-gray-700">
                {ALERT_TYPE_LABELS[route.alertType] ?? route.alertType}
              </span>
              <select
                name="routeTo_{route.alertType}"
                class="rounded border-gray-300 text-sm"
                value={route.routeTo}
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">All Members</option>
              </select>
            </div>
          {/each}
          <button
            type="submit"
            class="mt-4 rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
          >
            Save Routing
          </button>
        </form>
      </div>
    </div>
  {/if}
</div>
