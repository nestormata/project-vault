<script lang="ts">
  import { requestConfirm } from '$lib/state/confirm.svelte.js'
  import type { DormancyAlertView } from '$lib/notifications/dormancy-alerts.js'
  import { resolve } from '$app/paths'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { enhance } from '$app/forms'
  import DismissDormancyAlertForm from '$lib/components/notifications/DismissDormancyAlertForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  // Story 69.12: the actions of one machine key dormancy alert (dismiss with a reason, extend, revoke
  // after a confirmation, open the machine user). The point renders once per alert, as the last item
  // of the row. Nothing here is shared between alerts.
  let {
    alert,
    data,
  }: { alert: DormancyAlertView; data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region notifications.home.machine-dormancy-actions -->
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
      aria-describedby={`notification-dormancy-days-help-${alert.id}`}
    />
    <FormHelpText id={`notification-dormancy-days-help-${alert.id}`} kind="date" />
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
    use:enhance={async ({ cancel }) => {
      // AC-2's confirmation-before-destructive-action requirement applies to this DELETE
      // .../api-keys/:keyId call wherever it's triggered from — this inbox surface reuses
      // the same irreversible revoke endpoint the machine-user detail view gates behind
      // ConfirmDeleteButton, so it needs the same protection against an accidental click.
      const confirmed = await requestConfirm({
        title: 'Revoke key?',
        message: `Revoke the key "${alert.keyName}" for ${alert.machineUserName}? This cannot be undone.`,
        confirmLabel: 'Revoke',
        variant: 'danger',
      })
      if (!confirmed) cancel()
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
  </a><InjectionPoint name="notifications.home.machine-dormancy-actions" {data} />
</div>
