<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the webhook / S3 choice of the forwarding card as one replaceable region. The
  // Forwarder owns the choice; this component edits it through the bindable `type`.
  let {
    type = $bindable(),
    data,
  }: {
    type: 'webhook' | 's3'
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-forwarding.type -->
<RegionFragment>
  <div class="mt-4 flex gap-4 text-sm">
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="forwarderType"
        value="webhook"
        bind:group={type}
        aria-describedby="forwarder-type-help"
      />
      Webhook
    </label>
    <label class="flex items-center gap-2">
      <input
        type="radio"
        name="forwarderType"
        value="s3"
        bind:group={type}
        aria-describedby="forwarder-type-help"
      />
      S3-compatible
    </label>
  </div>
  <FormHelpText id="forwarder-type-help" kind="radio" /><InjectionPoint
    name="settings.audit-forwarding.type"
    {data}
  />
</RegionFragment>
