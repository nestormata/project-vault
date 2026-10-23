<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import {
    updateUserDormancyThreshold,
    type DormancyThresholdDays,
  } from '$lib/api/organization-settings.js'
  import DormancyThresholdOptions from '$lib/components/DormancyThresholdOptions.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the user dormancy threshold card. Its state is used by this card only (moved verbatim from the panel).
  let {
    orgId,
    data,
  }: {
    orgId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 8.7 AC-I1/I2/I3 — sibling "set a new value" control for the `user.dormant` alert
  // threshold, same D2 no-readback shape as the machine-key control above.
  let userDormancyThresholdChoice = $state<DormancyThresholdDays | ''>('')
  let userDormancySaving = $state(false)
  let userDormancySavedTo = $state<number | null>(null)
  let userDormancyError = $state<string | null>(null)
  async function onSaveUserDormancyThreshold() {
    if (userDormancySaving || userDormancyThresholdChoice === '') return
    userDormancySaving = true
    userDormancyError = null
    userDormancySavedTo = null
    try {
      const result = await updateUserDormancyThreshold(fetch, orgId, userDormancyThresholdChoice)
      userDormancySavedTo = result.userDormancyThresholdDays
    } catch (error) {
      userDormancyError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to update dormancy threshold.')
          : 'Failed to update dormancy threshold.'
    } finally {
      userDormancySaving = false
    }
  }
</script>

<!-- @region settings.users.user-dormancy -->
<div class="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">User dormancy alerts</h2>
  <p class="mt-2 text-sm text-slate-600">
    How long a user account can go without activity before a dormancy alert fires (Security Alerts /
    Notifications inbox).
  </p>
  <p class="mt-2 text-sm font-medium text-amber-800">
    Changing this threshold does not affect alerts already in your Dormant user alerts inbox.
  </p>
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <label class="sr-only" for="user-dormancy-threshold-select">
      User dormancy threshold (days)
    </label>
    <select
      id="user-dormancy-threshold-select"
      class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
      bind:value={userDormancyThresholdChoice}
      aria-describedby="user-dormancy-threshold-help"
    >
      <DormancyThresholdOptions />
    </select>
    <FormHelpText id="user-dormancy-threshold-help" kind="select" />
    <button
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      type="button"
      disabled={userDormancySaving || userDormancyThresholdChoice === ''}
      onclick={() => void onSaveUserDormancyThreshold()}
    >
      {userDormancySaving ? 'Saving…' : 'Save user dormancy threshold'}
    </button>
  </div>
  {#if userDormancySavedTo !== null}
    <p class="mt-2 text-sm text-emerald-700">
      Threshold updated to {userDormancySavedTo} days.
    </p>
  {/if}
  {#if userDormancyError}
    <p class="mt-2 text-sm text-red-700" role="alert">{userDormancyError}</p>
  {/if}<InjectionPoint name="settings.users.user-dormancy" {data} />
</div>
