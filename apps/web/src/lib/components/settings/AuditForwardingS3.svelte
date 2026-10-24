<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import AuditForwardingS3Credentials from './AuditForwardingS3Credentials.svelte'
  import AuditForwardingS3Destination from './AuditForwardingS3Destination.svelte'

  // Story 69.10: the S3-compatible form of the forwarding card as one replaceable region. The
  // Forwarder keeps the state (it survives switching to the webhook form and back); this form edits
  // it through bindable props and asks for a save through `onSave`.
  let {
    bucket = $bindable(),
    region = $bindable(),
    accessKeyId = $bindable(),
    secretAccessKey = $bindable(),
    prefix = $bindable(),
    endpoint = $bindable(),
    saving,
    error,
    configuredAt,
    onSave,
    data,
  }: {
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    prefix: string
    endpoint: string
    saving: boolean
    error: string | null
    configuredAt: string | null
    onSave: () => Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-forwarding.s3 -->
<div class="mt-4 flex flex-col gap-3">
  <AuditForwardingS3Destination bind:bucket bind:region {data} />
  <AuditForwardingS3Credentials bind:accessKeyId bind:secretAccessKey {data} />
  <label class="flex flex-col text-sm text-slate-700" for="s3-prefix">
    Prefix (optional)
    <input
      id="s3-prefix"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      bind:value={prefix}
      aria-describedby="s3-prefix-help"
    />
    <FormHelpText id="s3-prefix-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="s3-endpoint">
    Endpoint (optional, e.g. Minio)
    <input
      id="s3-endpoint"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      bind:value={endpoint}
      aria-describedby="s3-endpoint-help"
    />
    <FormHelpText id="s3-endpoint-help" kind="text" />
  </label>
  <button
    type="button"
    class="w-fit rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
    disabled={saving}
    onclick={() => void onSave()}
  >
    {saving ? 'Saving…' : 'Save S3'}
  </button>
  {#if error}
    <p class="text-sm text-red-700" role="alert">{error}</p>
  {/if}
  {#if configuredAt}
    <p class="text-sm text-emerald-700">
      Forwarding configured at {new Date(configuredAt).toLocaleString()}.
    </p>
  {/if}<InjectionPoint name="settings.audit-forwarding.s3" {data} />
</div>
