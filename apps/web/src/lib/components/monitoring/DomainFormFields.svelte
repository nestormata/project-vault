<!--
  The domainName/renewalDate/alertLeadDays field trio shared by the domain create and edit forms —
  the only difference between the two is the alert-lead-days placeholder (the create form shows
  an example; the edit form doesn't).
-->
<script lang="ts">
  import FieldInput from './FieldInput.svelte'

  let {
    domainName = $bindable(),
    renewalDate = $bindable(),
    alertLeadDays = $bindable(),
    fieldErrors,
    alertLeadDaysPlaceholder,
  }: {
    domainName: string
    renewalDate: string
    alertLeadDays: string
    fieldErrors: { domainName?: string; renewalDate?: string }
    alertLeadDaysPlaceholder?: string
  } = $props()
</script>

<FieldInput
  id="domain-name"
  label="Domain name"
  bind:value={domainName}
  error={fieldErrors.domainName}
/>
<FieldInput
  id="domain-renewal-date"
  label="Renewal date"
  type="date"
  bind:value={renewalDate}
  error={fieldErrors.renewalDate}
/>
<FieldInput
  id="domain-alert-lead-days"
  label="Alert me before renewal (days, comma-separated)"
  placeholder={alertLeadDaysPlaceholder}
  bind:value={alertLeadDays}
/>
