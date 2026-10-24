<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { RecoveryReset } from './recovery-reset.svelte.js'

  // Story 69.14: the optional two-factor re-enrollment of the recovery form (toggle, QR code, manual
  // key, authenticator code) as one replaceable region. The opt-in, the staged secret and the typed
  // code live in the recovery state owned by the page content and are never given to a point.
  let {
    flow,
    data,
  }: { flow: RecoveryReset; data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region auth.recovery-detail.mfa -->
<RegionFragment>
  <div class="space-y-2">
    <label class="flex items-center gap-2 font-medium text-slate-900">
      <input
        type="checkbox"
        checked={flow.wantsMfa}
        disabled={flow.isStartingMfa}
        onchange={() => void flow.toggleMfa()}
        aria-describedby="recovery-mfa-toggle-help"
      />
      Set up two-factor authentication
    </label>
    <FormHelpText id="recovery-mfa-toggle-help" kind="checkbox" />
    {#if flow.isStartingMfa}
      <p class="text-sm text-slate-600">Generating a new authenticator secret...</p>
    {/if}
    {#if flow.wantsMfa && flow.mfaQrCodeSvg}
      <div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p class="text-sm text-slate-600">Scan this code with your authenticator app:</p>
        <img
          class="w-40"
          alt="Authenticator QR code"
          src={`data:image/svg+xml;utf8,${encodeURIComponent(flow.mfaQrCodeSvg)}`}
        />
        {#if flow.mfaSecret}
          <p class="text-xs text-slate-500">Manual entry key: {flow.mfaSecret}</p>
        {/if}
        <label class="block font-medium text-slate-900" for="recovery-totp"
          >Authenticator code</label
        >
        <!-- Story 10-1: pattern="[0-9]{6}" is misparsed by Svelte's attribute compiler
             ("{6}" reads as a mustache expression, producing pattern="[0-9]6" in the rendered
             DOM) — see MfaLoginForm.svelte's identical fix for the full explanation. -->
        <input
          class="w-full rounded-xl border border-slate-300 px-3 py-2"
          id="recovery-totp"
          inputmode="numeric"
          pattern={'[0-9]{6}'}
          autocomplete="one-time-code"
          aria-describedby="recovery-totp-help"
          bind:value={flow.totpCode}
        />
        <FormHelpText id="recovery-totp-help" kind="secret" />
      </div>
    {/if}<InjectionPoint name="auth.recovery-detail.mfa" {data} />
  </div>
</RegionFragment>
