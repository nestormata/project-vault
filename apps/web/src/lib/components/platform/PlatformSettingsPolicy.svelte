<script lang="ts">
  import type { EffectiveInstancePolicy } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the Instance Policy card of the system settings as one replaceable region. The
  // settings form owns the editing state.
  let {
    maxOrgs = $bindable(),
    maxUsersPerOrg = $bindable(),
    sessionIdleTimeoutMinutes = $bindable(),
    policy,
    fieldErrors,
    data,
  }: {
    maxOrgs: string
    maxUsersPerOrg: string
    sessionIdleTimeoutMinutes: string
    policy: EffectiveInstancePolicy
    fieldErrors: Record<string, string>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.instance-policy -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-lg font-semibold text-gray-900">Instance Policy</h2>
  <div class="mt-4 grid grid-cols-2 gap-4">
    <label class="flex flex-col text-sm text-gray-700">
      Max orgs
      <input
        type="number"
        bind:value={maxOrgs}
        placeholder={policy.maxOrgs.toString()}
        class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
        aria-describedby="max-orgs-help"
      />
      {#if fieldErrors['instancePolicy.maxOrgs']}
        <span class="text-xs text-red-600">{fieldErrors['instancePolicy.maxOrgs']}</span>
      {/if}
    </label>
    <FormHelpText id="max-orgs-help" kind="date" />
    <label class="flex flex-col text-sm text-gray-700">
      Max users per org
      <input
        type="number"
        bind:value={maxUsersPerOrg}
        placeholder={policy.maxUsersPerOrg.toString()}
        class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
        aria-describedby="max-users-help"
      />
      {#if fieldErrors['instancePolicy.maxUsersPerOrg']}
        <span class="text-xs text-red-600">{fieldErrors['instancePolicy.maxUsersPerOrg']}</span>
      {/if}
    </label>
    <FormHelpText id="max-users-help" kind="date" />
    <label class="flex flex-col text-sm text-gray-700">
      Session idle timeout (minutes)
      <input
        type="number"
        bind:value={sessionIdleTimeoutMinutes}
        placeholder={policy.sessionIdleTimeoutMinutes.toString()}
        class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
        aria-describedby="session-idle-help"
      />
    </label>
    <FormHelpText id="session-idle-help" kind="date" /><InjectionPoint
      name="platform.settings.instance-policy"
      {data}
    />
  </div>
</section>
