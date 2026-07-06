<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { dismissAlert, snoozeAlert, type MonitoringAlert } from '$lib/api/monitoring-alerts.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import {
    canDismissAlert,
    canManageMonitoredAssets,
    type OrgRole,
  } from '$lib/monitoring/permissions.js'

  let {
    alerts,
    endpoints,
    orgRole,
    projectId,
  }: {
    alerts: MonitoringAlert[]
    endpoints: { id: string; name: string }[]
    orgRole: OrgRole
    projectId: string
  } = $props()

  // A writable $derived: resets to the `alerts` prop whenever it changes (new load/navigation),
  // while remaining locally reassignable for the optimistic snooze/dismiss updates below.
  let localAlerts = $derived<MonitoringAlert[]>(alerts)
  let errorMessage = $state<string | null>(null)

  const canSnooze = $derived(canManageMonitoredAssets(orgRole))
  const canDismiss = $derived(canDismissAlert(orgRole))

  // AC-F2: preset durations, each mapped to durationMinutes, capped server-side at 10080 (7 days).
  const snoozePresets: { label: string; minutes: number }[] = [
    { label: 'Snooze 30 min', minutes: 30 },
    { label: 'Snooze 1 hour', minutes: 60 },
    { label: 'Snooze 4 hours', minutes: 240 },
    { label: 'Snooze 24 hours', minutes: 1440 },
  ]

  function endpointName(serviceEndpointId: string | null): string {
    if (!serviceEndpointId) return 'Endpoint deleted'
    return endpoints.find((e) => e.id === serviceEndpointId)?.name ?? 'Endpoint deleted'
  }

  function formatDateTime(value: string): string {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  async function handleSnooze(alertId: string, minutes: number) {
    errorMessage = null
    try {
      const updated = await snoozeAlert(fetch, projectId, alertId, { durationMinutes: minutes })
      localAlerts = localAlerts.map((a) => (a.id === alertId ? updated : a))
    } catch (error) {
      // AC-F2 failure: a stale 409 (e.g. dismissed by another session) is shown as a plain error,
      // not an unhandled exception — the panel's next full load will reflect the current state.
      errorMessage = error instanceof Error ? error.message : 'Could not snooze alert.'
      if (error instanceof ApiClientError && error.status === 409) {
        errorMessage = error.message
      }
    }
  }

  async function handleDismiss(alertId: string) {
    errorMessage = null
    try {
      await dismissAlert(fetch, projectId, alertId)
      localAlerts = localAlerts.filter((a) => a.id !== alertId)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not dismiss alert.'
    }
  }
</script>

<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Active alerts</h2>

  {#if errorMessage}
    <p
      class="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {errorMessage}
    </p>
  {/if}

  {#if localAlerts.length === 0}
    <p class="mt-3 text-sm text-slate-600">No active alerts</p>
  {:else}
    <ul class="mt-4 space-y-3">
      {#each localAlerts as alert (alert.id)}
        <li
          class={`rounded-xl border p-4 ${alert.severity === 'critical' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="font-semibold text-slate-950">{endpointName(alert.serviceEndpointId)}</p>
              <p class="text-sm text-slate-600">
                {alert.alertType} · {alert.severity} · {formatDateTime(alert.createdAt)}
              </p>
              {#if alert.status === 'snoozed' && alert.snoozedUntil}
                <p class="text-sm text-slate-600">
                  Snoozed until {formatDateTime(alert.snoozedUntil)}
                </p>
              {/if}
            </div>
            <div class="flex flex-wrap items-center gap-2">
              {#if canSnooze}
                {#each snoozePresets as preset (preset.minutes)}
                  <button
                    class="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-900"
                    type="button"
                    onclick={() => void handleSnooze(alert.id, preset.minutes)}
                  >
                    {preset.label}
                  </button>
                {/each}
              {/if}
              {#if canDismiss}
                <ConfirmDeleteButton
                  label="Dismiss"
                  confirmLabel="Confirm dismiss?"
                  pendingLabel="Dismissing…"
                  onConfirm={() => handleDismiss(alert.id)}
                />
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
