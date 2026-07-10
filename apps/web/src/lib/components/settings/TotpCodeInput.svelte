<!--
  The labeled "Authenticator code" input, shared by MfaEnrollmentPanel's verify-enrollment and
  regenerate-recovery-codes flows (jscpd flagged the two copies as duplication).
-->
<script lang="ts">
  let {
    value = $bindable(),
    helperText,
  }: {
    value: string
    helperText: string
  } = $props()
</script>

<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="mfa-security-totp">Authenticator code</label>
  <!-- Story 10-1: pattern="[0-9]{6}" is misparsed by Svelte's attribute compiler ("{6}" reads as
       a mustache expression, producing pattern="[0-9]6" in the rendered DOM) — see
       MfaLoginForm.svelte's identical fix for the full explanation. Wrapping in a JS expression
       avoids the mixed-content parse. -->
  <input
    id="mfa-security-totp"
    class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
    inputmode="numeric"
    pattern={'[0-9]{6}'}
    autocomplete="one-time-code"
    bind:value
    required
  />
  <p class="text-sm text-slate-600">{helperText}</p>
</div>
