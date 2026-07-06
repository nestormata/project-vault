<!--
  The domain/expiresAt/alertLeadDays field trio shared by the certificate create and edit forms —
  the only difference between the two is the alert-lead-days placeholder (the create form shows
  an example; the edit form doesn't).
-->
<script lang="ts">
  import FieldInput from './FieldInput.svelte'

  let {
    domain = $bindable(),
    expiresAt = $bindable(),
    alertLeadDays = $bindable(),
    fieldErrors,
    alertLeadDaysPlaceholder,
  }: {
    domain: string
    expiresAt: string
    alertLeadDays: string
    fieldErrors: { domain?: string; expiresAt?: string }
    alertLeadDaysPlaceholder?: string
  } = $props()
</script>

<FieldInput id="certificate-domain" label="Domain" bind:value={domain} error={fieldErrors.domain} />
<FieldInput
  id="certificate-expires-at"
  label="Expiry date"
  type="date"
  bind:value={expiresAt}
  error={fieldErrors.expiresAt}
/>
<FieldInput
  id="certificate-alert-lead-days"
  label="Alert me before expiry (days, comma-separated)"
  placeholder={alertLeadDaysPlaceholder}
  bind:value={alertLeadDays}
/>
