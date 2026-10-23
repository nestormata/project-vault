<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import {
    updateMachineKeyDormancyThreshold,
    type DormancyThresholdDays,
  } from '$lib/api/organization-settings.js'
  import DormancyThresholdOptions from '$lib/components/DormancyThresholdOptions.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the machine-key dormancy threshold card. Its state is used by this card only (moved verbatim from the panel).
  let {
    orgId,
    data,
  }: {
    orgId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // AC-4 — machine-key dormancy alert threshold. Deliberately a "set new value" control, not a
  // pre-populated one: the API only ships a PATCH for this setting (no GET), and this story is
  // scoped to add no new backend endpoint for AC-1–AC-4, so the current org value cannot be read
  // and displayed here without one. Defaulting the select to a real option would misleadingly
  // imply that's the current value, so it starts unselected instead.
  let dormancyThresholdChoice = $state<DormancyThresholdDays | ''>('')
  let dormancySaving = $state(false)
  let dormancySavedTo = $state<number | null>(null)
  let dormancyError = $state<string | null>(null)
  async function onSaveDormancyThreshold() {
    if (dormancySaving || dormancyThresholdChoice === '') return
    dormancySaving = true
    dormancyError = null
    dormancySavedTo = null
    try {
      const result = await updateMachineKeyDormancyThreshold(fetch, orgId, dormancyThresholdChoice)
      dormancySavedTo = result.machineKeyDormancyThresholdDays
    } catch (error) {
      dormancyError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to update dormancy threshold.')
          : 'Failed to update dormancy threshold.'
    } finally {
      dormancySaving = false
    }
  }
</script>

<!-- @region settings.users.machine-dormancy -->
<div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Machine key dormancy alerts</h2>
  <p class="mt-2 text-sm text-slate-600">
    How long a machine-user API key can go unused before a dormancy alert fires (Security Alerts /
    Notifications inbox).
  </p>
  <p class="mt-2 text-sm font-medium text-amber-800">
    Changing this is not retroactive: alerts already fired under the old threshold are not
    reconciled or auto-dismissed when you change this setting.
  </p>
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <label class="sr-only" for="dormancy-threshold-select">Dormancy threshold (days)</label>
    <select
      id="dormancy-threshold-select"
      class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
      bind:value={dormancyThresholdChoice}
      aria-describedby="machine-dormancy-threshold-help"
    >
      <DormancyThresholdOptions />
    </select>
    <FormHelpText id="machine-dormancy-threshold-help" kind="select" />
    <button
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      type="button"
      disabled={dormancySaving || dormancyThresholdChoice === ''}
      onclick={() => void onSaveDormancyThreshold()}
    >
      {dormancySaving ? 'Saving…' : 'Save'}
    </button>
  </div>
  {#if dormancySavedTo !== null}
    <p class="mt-2 text-sm text-emerald-700">
      Threshold updated to {dormancySavedTo} days.
    </p>
  {/if}
  {#if dormancyError}
    <p class="mt-2 text-sm text-red-700" role="alert">{dormancyError}</p>
  {/if}<InjectionPoint name="settings.users.machine-dormancy" {data} />
</div>
