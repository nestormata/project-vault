<script lang="ts">
  import { resolve } from '$app/paths'
  import { updateAuditForwarding, updateAuditRetention } from '$lib/api/audit.js'
  import { ApiClientError } from '$lib/api/client.js'

  let { data } = $props()

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

  // --- Retention (AC group F) --------------------------------------------------------------
  const RETENTION_MIN_DAYS = 30
  const RETENTION_MAX_DAYS = 3650

  let retentionDaysInput = $state('')
  let retainForever = $state(false)
  let retentionClientError = $state<string | null>(null)
  let retentionServerError = $state<string | null>(null)
  let retentionSaving = $state(false)
  let retentionConfirmation = $state<string | null>(null)

  async function onSaveRetention() {
    retentionClientError = null
    retentionServerError = null
    retentionConfirmation = null

    let retentionDays: number | null
    if (retainForever) {
      retentionDays = null
    } else {
      const parsed = Number(retentionDaysInput)
      if (!Number.isInteger(parsed) || parsed < RETENTION_MIN_DAYS || parsed > RETENTION_MAX_DAYS) {
        retentionClientError = `Retention must be between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS.toLocaleString()} days`
        return
      }
      retentionDays = parsed
    }

    retentionSaving = true
    try {
      const result = await updateAuditRetention(fetch, retentionDays)
      retentionConfirmation =
        result.retentionDays === null
          ? 'Audit events will be retained indefinitely.'
          : `Retention set to ${result.retentionDays} days.`
    } catch (err) {
      retentionServerError =
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to update retention')
          : 'Failed to update retention'
    } finally {
      retentionSaving = false
    }
  }
</script>

<svelte:head>
  <title>Forwarding & Retention | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Forwarding &amp; Retention</h1>
  <a href={resolve('/settings/audit')} class="mt-2 inline-block text-sm text-indigo-600 underline">
    ← Back to Audit Log
  </a>

  {#if !data.allowed}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This page requires the admin role or above.</p>
    </div>
  {:else}
    <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Forwarding</h2>
      <p class="mt-2 text-sm font-medium text-amber-800">
        Project Vault does not currently display your saved forwarding configuration — this form
        always sets a new value.
      </p>
      <p class="mt-1 text-xs text-slate-500">
        There is currently no way to turn off forwarding once configured — this form only configures
        or reconfigures a forwarder.
      </p>

      <div class="mt-4 flex gap-4 text-sm">
        <label class="flex items-center gap-2">
          <input type="radio" name="forwarderType" value="webhook" bind:group={forwarderType} />
          Webhook
        </label>
        <label class="flex items-center gap-2">
          <input type="radio" name="forwarderType" value="s3" bind:group={forwarderType} />
          S3-compatible
        </label>
      </div>

      {#if forwarderType === 'webhook'}
        <div class="mt-4 flex flex-col gap-3">
          <label class="flex flex-col text-sm text-slate-700" for="webhook-url">
            Webhook URL
            <input
              id="webhook-url"
              type="text"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={webhookUrl}
              placeholder="https://siem.example.com/ingest"
            />
          </label>
          <label class="flex flex-col text-sm text-slate-700" for="webhook-secret">
            Secret header
            <input
              id="webhook-secret"
              type="password"
              autocomplete="off"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={secretHeader}
            />
          </label>
          <button
            type="button"
            class="w-fit rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={webhookSaving}
            onclick={() => void onSaveWebhook()}
          >
            {webhookSaving ? 'Saving…' : 'Save webhook'}
          </button>
          {#if webhookClientError}
            <p class="text-sm text-red-700" role="alert">{webhookClientError}</p>
          {/if}
          {#if webhookServerError}
            <p class="text-sm text-red-700" role="alert">{webhookServerError}</p>
          {/if}
          {#if webhookConfiguredAt}
            <p class="text-sm text-emerald-700">
              Webhook forwarding configured at {new Date(webhookConfiguredAt).toLocaleString()}.
            </p>
          {/if}
        </div>
      {:else}
        <div class="mt-4 flex flex-col gap-3">
          <label class="flex flex-col text-sm text-slate-700" for="s3-bucket">
            Bucket
            <input
              id="s3-bucket"
              type="text"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={bucket}
            />
          </label>
          <label class="flex flex-col text-sm text-slate-700" for="s3-region">
            Region
            <input
              id="s3-region"
              type="text"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={region}
            />
          </label>
          <label class="flex flex-col text-sm text-slate-700" for="s3-access-key">
            Access key ID
            <input
              id="s3-access-key"
              type="password"
              autocomplete="off"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={accessKeyId}
            />
          </label>
          <label class="flex flex-col text-sm text-slate-700" for="s3-secret-key">
            Secret access key
            <input
              id="s3-secret-key"
              type="password"
              autocomplete="off"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={secretAccessKey}
            />
          </label>
          <label class="flex flex-col text-sm text-slate-700" for="s3-prefix">
            Prefix (optional)
            <input
              id="s3-prefix"
              type="text"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={prefix}
            />
          </label>
          <label class="flex flex-col text-sm text-slate-700" for="s3-endpoint">
            Endpoint (optional, e.g. Minio)
            <input
              id="s3-endpoint"
              type="text"
              class="rounded-lg border border-slate-300 px-2 py-1"
              bind:value={endpoint}
            />
          </label>
          <button
            type="button"
            class="w-fit rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={s3Saving}
            onclick={() => void onSaveS3()}
          >
            {s3Saving ? 'Saving…' : 'Save S3'}
          </button>
          {#if s3Error}
            <p class="text-sm text-red-700" role="alert">{s3Error}</p>
          {/if}
          {#if s3ConfiguredAt}
            <p class="text-sm text-emerald-700">
              Forwarding configured at {new Date(s3ConfiguredAt).toLocaleString()}.
            </p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Retention</h2>
      <p class="mt-2 text-sm font-medium text-amber-800">
        Project Vault does not currently display your saved retention configuration — this form
        always sets a new value.
      </p>

      <div class="mt-4 flex flex-col gap-3">
        <label class="flex flex-col text-sm text-slate-700" for="retention-days">
          Retention (days)
          <input
            id="retention-days"
            type="number"
            class="rounded-lg border border-slate-300 px-2 py-1"
            bind:value={retentionDaysInput}
            disabled={retainForever}
          />
        </label>
        <label class="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" bind:checked={retainForever} />
          Never automatically delete audit events
        </label>
        <button
          type="button"
          class="w-fit rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={retentionSaving}
          onclick={() => void onSaveRetention()}
        >
          {retentionSaving ? 'Saving…' : 'Save retention'}
        </button>
        {#if retentionClientError}
          <p class="text-sm text-red-700" role="alert">{retentionClientError}</p>
        {/if}
        {#if retentionServerError}
          <p class="text-sm text-red-700" role="alert">{retentionServerError}</p>
        {/if}
        {#if retentionConfirmation}
          <p class="text-sm text-emerald-700">{retentionConfirmation}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
