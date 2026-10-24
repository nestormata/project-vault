<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { updateAuditForwarding } from '$lib/api/audit.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import AuditForwardingS3 from './AuditForwardingS3.svelte'
  import AuditForwardingTypeChoice from './AuditForwardingTypeChoice.svelte'
  import AuditForwardingWebhook from './AuditForwardingWebhook.svelte'

  // Story 69.10: the Forwarding card of the forwarding page as one replaceable region. This
  // component owns ALL forwarding state (the chosen type and both forms' values), so typing in one
  // form survives switching to the other; the two forms are sub-regions that edit it through
  // bindable props and save through `onSave` callbacks (moved verbatim from the panel).
  let {
    data,
  }: {
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // --- Webhook forwarding (AC-E1/E2/E4) ---------------------------------------------------
  let forwarderType = $state<'webhook' | 's3'>('webhook')
  let webhookUrl = $state('')
  let secretHeader = $state('')
  let webhookClientError = $state<string | null>(null)
  let webhookServerError = $state<string | null>(null)
  let webhookSaving = $state(false)
  let webhookConfiguredAt = $state<string | null>(null)
  async function onSaveWebhook() {
    webhookClientError = null
    webhookServerError = null
    webhookConfiguredAt = null
    // AC-E2 — client-side https check; SSRF/private-address rejection is correctly server-only
    // (DNS resolution is unavailable in a browser context).
    if (!webhookUrl.startsWith('https://')) {
      webhookClientError = 'URL must use https://'
      return
    }
    webhookSaving = true
    try {
      const result = await updateAuditForwarding(fetch, {
        type: 'webhook',
        config: { url: webhookUrl, secretHeader },
      })
      webhookConfiguredAt = result.configuredAt
      secretHeader = ''
    } catch (err) {
      webhookServerError =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to configure webhook forwarding')
          : 'Failed to configure webhook forwarding'
    } finally {
      webhookSaving = false
    }
  }
  // --- S3-compatible forwarding (AC-E3/E4) ------------------------------------------------
  let bucket = $state('')
  let region = $state('')
  let accessKeyId = $state('')
  let secretAccessKey = $state('')
  let prefix = $state('')
  let endpoint = $state('')
  let s3Error = $state<string | null>(null)
  let s3Saving = $state(false)
  let s3ConfiguredAt = $state<string | null>(null)
  async function onSaveS3() {
    s3Error = null
    s3ConfiguredAt = null
    if (endpoint && !endpoint.startsWith('https://')) {
      s3Error = 'Endpoint must use https://'
      return
    }
    s3Saving = true
    try {
      const result = await updateAuditForwarding(fetch, {
        type: 's3',
        config: {
          bucket,
          region,
          accessKeyId,
          secretAccessKey,
          ...(prefix ? { prefix } : {}),
          ...(endpoint ? { endpoint } : {}),
        },
      })
      s3ConfiguredAt = result.configuredAt
      // AC-E3 — neither key is ever redisplayed; clear both fields (and prefix/endpoint) after a
      // successful submit rather than retaining them in page state.
      accessKeyId = ''
      secretAccessKey = ''
    } catch (err) {
      s3Error =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to configure S3 forwarding')
          : 'Failed to configure S3 forwarding'
    } finally {
      s3Saving = false
    }
  }
</script>

<!-- @region settings.audit-forwarding.forwarder -->
<div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Forwarding</h2>
  <p class="mt-2 text-sm font-medium text-amber-800">
    Project Vault does not currently display your saved forwarding configuration — this form always
    sets a new value.
  </p>
  <p class="mt-1 text-xs text-slate-500">
    There is currently no way to turn off forwarding once configured — this form only configures or
    reconfigures a forwarder.
  </p>

  <AuditForwardingTypeChoice bind:type={forwarderType} {data} />

  {#if forwarderType === 'webhook'}
    <AuditForwardingWebhook
      bind:url={webhookUrl}
      bind:secretHeader
      saving={webhookSaving}
      clientError={webhookClientError}
      serverError={webhookServerError}
      configuredAt={webhookConfiguredAt}
      onSave={onSaveWebhook}
      {data}
    />
  {:else}
    <AuditForwardingS3
      bind:bucket
      bind:region
      bind:accessKeyId
      bind:secretAccessKey
      bind:prefix
      bind:endpoint
      saving={s3Saving}
      error={s3Error}
      configuredAt={s3ConfiguredAt}
      onSave={onSaveS3}
      {data}
    />
  {/if}<InjectionPoint name="settings.audit-forwarding.forwarder" {data} />
</div>
