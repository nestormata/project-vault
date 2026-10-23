<script lang="ts">
  import { updateUserDormancyThreshold } from '$lib/api/organization-settings.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import DormancyThresholdOptions from '$lib/components/DormancyThresholdOptions.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import UsersDormancyCard from './UsersDormancyCard.svelte'

  // Story 69.10: the user dormancy threshold card as one replaceable region. Story 8.7 AC-I1/I2/I3 —
  // the sibling "set a new value" control for the `user.dormant` alert threshold, same no-readback
  // shape as the machine-key control.
  let { orgId, data }: { orgId: string; data?: Record<string, readonly unknown[]> | undefined } =
    $props()
</script>

<!-- @region settings.users.user-dormancy -->
<UsersDormancyCard
  spacing="mt-4"
  heading="User dormancy alerts"
  description="How long a user account can go without activity before a dormancy alert fires (Security Alerts / Notifications inbox)."
  notice="Changing this threshold does not affect alerts already in your Dormant user alerts inbox."
  label="User dormancy threshold (days)"
  labelFor="user-dormancy-threshold-select"
  saveLabel="Save user dormancy threshold"
  save={async (days) =>
    (await updateUserDormancyThreshold(fetch, orgId, days)).userDormancyThresholdDays}
>
  {#snippet select(threshold)}
    <select
      id="user-dormancy-threshold-select"
      class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
      bind:value={threshold.choice}
      aria-describedby="user-dormancy-threshold-help"
    >
      <DormancyThresholdOptions />
    </select>
    <FormHelpText id="user-dormancy-threshold-help" kind="select" />
  {/snippet}
  <InjectionPoint name="settings.users.user-dormancy" {data} />
</UsersDormancyCard>
