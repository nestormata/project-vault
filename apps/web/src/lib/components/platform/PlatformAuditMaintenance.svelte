<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import {
    getMaintenanceModeStatus,
    postMaintenanceMode,
    type MaintenanceModeStatus,
  } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'

  // Story 69.10: the "Maintenance Mode" card of the platform audit log as one replaceable region.
  // The content component owns the status (the banner above reads it too); this card refreshes it
  // through the bindable `status` / `statusError` after an activation or deactivation.
  let {
    status = $bindable(),
    statusError = $bindable(),
    data,
  }: {
    status: MaintenanceModeStatus | null
    statusError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  let activateReason = $state('')
  let maintenanceError = $state<string | null>(null)
  let maintenanceMfaError = $state<string | null>(null)
  async function refreshMaintenanceStatus() {
    try {
      status = await getMaintenanceModeStatus(fetch)
      statusError = null
    } catch {
      statusError =
        'Maintenance mode status unavailable — action disabled until status can be confirmed'
    }
  }
  async function handleActivateMaintenance() {
    maintenanceError = null
    maintenanceMfaError = null
    try {
      await postMaintenanceMode(fetch, { action: 'activate', reason: activateReason.trim() })
      activateReason = ''
      await refreshMaintenanceStatus()
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403 && err.code === 'mfa_required') {
          maintenanceMfaError = err.message ?? 'MFA required'
        } else if (err.status === 409) {
          maintenanceError = err.message ?? 'Maintenance mode is already active.'
          await refreshMaintenanceStatus()
        } else {
          maintenanceError = err.message ?? 'Failed to activate maintenance mode'
        }
      } else {
        maintenanceError = 'Failed to activate maintenance mode'
      }
    }
  }
  async function handleDeactivateMaintenance() {
    maintenanceError = null
    maintenanceMfaError = null
    try {
      await postMaintenanceMode(fetch, { action: 'deactivate' })
      await refreshMaintenanceStatus()
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403 && err.code === 'mfa_required') {
          maintenanceMfaError = err.message ?? 'MFA required'
        } else if (err.status === 503) {
          maintenanceError =
            err.message ??
            'Cannot deactivate maintenance mode: platform audit log is still unavailable'
          await refreshMaintenanceStatus()
        } else {
          maintenanceError = err.message ?? 'Failed to deactivate maintenance mode'
        }
      } else {
        maintenanceError = 'Failed to deactivate maintenance mode'
      }
    }
  }
</script>

<!-- @region platform.audit.maintenance -->
<div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Maintenance Mode</h2>
  <p class="mt-1 text-sm text-slate-500">
    Maintenance mode bypasses the fail-closed audit guarantee to allow recovery during storage
    outages. Use only when the platform audit log is genuinely unavailable.
  </p>

  {#if maintenanceError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {maintenanceError}
    </p>
  {/if}
  {#if maintenanceMfaError}
    <MfaAwareErrorAlert
      message={maintenanceMfaError}
      class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    />
  {/if}

  {#if statusError}
    <p class="mt-4 text-sm text-gray-500 italic">
      Actions disabled — maintenance mode status unavailable.
    </p>
  {:else if status?.active}
    <div class="mt-4">
      <ConfirmDeleteButton
        label="Deactivate maintenance mode"
        confirmLabel="Confirm deactivation?"
        pendingLabel="Deactivating…"
        onConfirm={handleDeactivateMaintenance}
      />
    </div>
  {:else}
    <div class="mt-4 flex flex-col gap-3">
      <label class="flex flex-col text-sm text-gray-700">
        Reason (required to activate)
        <textarea
          class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
          rows="2"
          bind:value={activateReason}
          placeholder="Reason for activating maintenance mode"
          aria-describedby="maintenance-reason-help"></textarea>
        <FormHelpText id="maintenance-reason-help" kind="text" />
      </label>
      <div>
        <ConfirmDeleteButton
          label="Activate maintenance mode"
          confirmLabel="Confirm activation?"
          pendingLabel="Activating…"
          disabled={activateReason.trim().length === 0}
          onConfirm={handleActivateMaintenance}
        />
      </div>
    </div>
  {/if}<InjectionPoint name="platform.audit.maintenance" {data} />
</div>
