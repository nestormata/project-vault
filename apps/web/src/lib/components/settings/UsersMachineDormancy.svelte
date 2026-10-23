<script lang="ts">
  import { updateMachineKeyDormancyThreshold } from '$lib/api/organization-settings.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import DormancyThresholdOptions from '$lib/components/DormancyThresholdOptions.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import UsersDormancyCard from './UsersDormancyCard.svelte'

  // Story 69.10: the machine-key dormancy threshold card as one replaceable region.
  // AC-4 — Deliberately a "set new value" control, not a pre-populated one: the API only ships a PATCH
  // for this setting (no GET), so the current org value cannot be read and displayed here. Defaulting
  // the select to a real option would misleadingly imply that's the current value.
  let { orgId, data }: { orgId: string; data?: Record<string, readonly unknown[]> | undefined } =
    $props()
</script>

<!-- @region settings.users.machine-dormancy -->
<UsersDormancyCard
  spacing="mt-8"
  heading="Machine key dormancy alerts"
  description="How long a machine-user API key can go unused before a dormancy alert fires (Security Alerts / Notifications inbox)."
  notice="Changing this is not retroactive: alerts already fired under the old threshold are not reconciled or auto-dismissed when you change this setting."
  label="Dormancy threshold (days)"
  labelFor="dormancy-threshold-select"
  saveLabel="Save"
  save={async (days) =>
    (await updateMachineKeyDormancyThreshold(fetch, orgId, days)).machineKeyDormancyThresholdDays}
>
  {#snippet select(threshold)}
    <select
      id="dormancy-threshold-select"
      class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
      bind:value={threshold.choice}
      aria-describedby="machine-dormancy-threshold-help"
    >
      <DormancyThresholdOptions />
    </select>
    <FormHelpText id="machine-dormancy-threshold-help" kind="select" />
  {/snippet}
  <InjectionPoint name="settings.users.machine-dormancy" {data} />
</UsersDormancyCard>
