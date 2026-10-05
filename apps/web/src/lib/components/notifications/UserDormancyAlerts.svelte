<script lang="ts">
  import type { UserDormancyAlertView } from '$lib/notifications/dormancy-alerts.js'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import { enhance } from '$app/forms'
  import DismissDormancyAlertForm from '$lib/components/notifications/DismissDormancyAlertForm.svelte'

  let {
    canManageDormancy,
    userDormancyAlerts,
    children,
  }: {
    canManageDormancy: boolean
    userDormancyAlerts: UserDormancyAlertView[]
    children?: Snippet
  } = $props()
</script>

{#if canManageDormancy}
  <div class="mb-6 space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500">Dormant user alerts</h2>
    {#if userDormancyAlerts.length === 0}
      <p class="text-sm text-gray-500">No dormant user alerts.</p>
    {:else}
      {#each userDormancyAlerts as alert (alert.id)}
        <div class="rounded-lg border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
          <p class="text-sm font-semibold text-gray-900">
            {alert.displayName} — {alert.orgRole}
          </p>
          <p class="mt-1 text-sm text-gray-600">
            Last active: {alert.lastActiveAt
              ? new Date(alert.lastActiveAt).toLocaleDateString()
              : 'Never active'}
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-4">
            <DismissDormancyAlertForm alertId={alert.id} />

            <form
              method="POST"
              action="?/deactivateDormantUser"
              use:enhance={({ cancel }) => {
                if (!confirm(`Deactivate ${alert.displayName}? This cannot be undone.`)) {
                  cancel()
                }
              }}
            >
              <input type="hidden" name="userId" value={alert.userId} />
              <button
                type="submit"
                class="cursor-pointer text-xs font-medium text-amber-700 hover:text-amber-900"
              >
                Deactivate account
              </button>
            </form>

            <a href={resolve('/settings/users')} class="text-xs text-indigo-600 hover:underline">
              Pseudonymize identity →
            </a>
          </div>
        </div>
      {/each}
    {/if}
  </div>
{/if}
{@render children?.()}
