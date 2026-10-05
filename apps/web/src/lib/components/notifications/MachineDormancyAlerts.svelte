<script lang="ts">
  import type { DormancyAlertView } from '$lib/notifications/dormancy-alerts.js'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { enhance } from '$app/forms'
  import DismissDormancyAlertForm from '$lib/components/notifications/DismissDormancyAlertForm.svelte'

  let { dormancyAlerts, children }: { dormancyAlerts: DormancyAlertView[]; children?: Snippet } =
    $props()
</script>

{#if dormancyAlerts.length > 0}
  <div class="mb-6 space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500">
      Machine key dormancy alerts
    </h2>
    {#each dormancyAlerts as alert (alert.id)}
      <div class="rounded-lg border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
        <p class="text-sm font-semibold text-gray-900">
          {alert.machineUserName} — key "{alert.keyName}"
        </p>
        <p class="mt-1 text-sm text-gray-600">
          Last used: {alert.lastUsedAt ? new Date(alert.lastUsedAt).toLocaleDateString() : 'never'}
        </p>

        <div class="mt-3 flex flex-wrap items-center gap-4">
          <DismissDormancyAlertForm alertId={alert.id} />

          <form method="POST" action="?/extendDormancy" use:enhance class="flex items-center gap-2">
            <input type="hidden" name="machineUserId" value={alert.machineUserId} />
            <input type="hidden" name="keyId" value={alert.keyId} />
            <input
              type="number"
              name="days"
              value="30"
              min="1"
              max="365"
              class="w-16 rounded border border-gray-300 px-2 py-1 text-xs"
              aria-describedby="notification-dormancy-days-help"
            />
            <FormHelpText id="notification-dormancy-days-help" kind="date" />
            <button
              type="submit"
              class="cursor-pointer text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              Extend (days)
            </button>
          </form>

          <form
            method="POST"
            action="?/revokeDormantKey"
            use:enhance={({ cancel }) => {
              // AC-2's confirmation-before-destructive-action requirement applies to this DELETE
              // .../api-keys/:keyId call wherever it's triggered from — this inbox surface reuses
              // the same irreversible revoke endpoint the machine-user detail view gates behind
              // ConfirmDeleteButton, so it needs the same protection against an accidental click.
              if (
                !confirm(
                  `Revoke the key "${alert.keyName}" for ${alert.machineUserName}? This cannot be undone.`
                )
              ) {
                cancel()
              }
            }}
          >
            <input type="hidden" name="machineUserId" value={alert.machineUserId} />
            <input type="hidden" name="keyId" value={alert.keyId} />
            <button
              type="submit"
              class="cursor-pointer text-xs font-medium text-red-600 hover:text-red-800"
            >
              Revoke key
            </button>
          </form>

          <a
            href={resolve(`/projects/${alert.projectId}/machine-users/${alert.machineUserId}`)}
            class="text-xs text-indigo-600 hover:underline"
          >
            View machine user →
          </a>
        </div>
      </div>
    {/each}
  </div>
{/if}
{@render children?.()}
