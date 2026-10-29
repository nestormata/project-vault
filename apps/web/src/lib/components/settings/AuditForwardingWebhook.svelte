<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the webhook form of the forwarding card as one replaceable region. The Forwarder
  // keeps the state (it survives switching to S3 and back); this form edits it through bindable
  // props and asks for a save through `onSave`.
  let {
    url = $bindable(),
    secretHeader = $bindable(),
    saving,
    clientError,
    serverError,
    configuredAt,
    onSave,
    data,
  }: {
    url: string
    secretHeader: string
    saving: boolean
    clientError: string | null
    serverError: string | null
    configuredAt: string | null
    onSave: () => Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-forwarding.webhook -->
<div class="mt-4 flex flex-col gap-3">
  <label class="flex flex-col text-sm text-slate-700" for="webhook-url">
    Webhook URL
    <input
      id="webhook-url"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      bind:value={url}
      placeholder="https://siem.example.com/ingest"
      aria-describedby="webhook-url-help"
    />
    <FormHelpText id="webhook-url-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="webhook-secret">
    Secret header
    <input
      id="webhook-secret"
      type="password"
      autocomplete="off"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      bind:value={secretHeader}
      aria-describedby="webhook-secret-help"
    />
    <FormHelpText id="webhook-secret-help" kind="secret" />
  </label>
  <button
    type="button"
    class="w-fit rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
    disabled={saving}
    onclick={() => void onSave()}
  >
    {saving ? 'Saving…' : 'Save webhook'}
  </button>
  {#if clientError}
    <p class="text-sm text-red-700" role="alert">{clientError}</p>
  {/if}
  {#if serverError}
    <p class="text-sm text-red-700" role="alert">{serverError}</p>
  {/if}
  {#if configuredAt}
    <p class="text-sm text-emerald-700">
      Webhook forwarding configured at {new Date(configuredAt).toLocaleString()}.
    </p>
  {/if}<InjectionPoint name="settings.audit-forwarding.webhook" {data} />
</div>
