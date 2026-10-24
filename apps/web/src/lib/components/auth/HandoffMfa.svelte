<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import MfaLoginForm from '$lib/components/auth/MfaLoginForm.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Story 69.11: the MFA prompt shown when the confirmed handoff needs a second factor.
  let {
    mfaToken,
    onExpired,
    onAuthenticated,
    data,
  }: {
    mfaToken: string
    onExpired: () => void
    onAuthenticated: () => Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region auth.handoff.mfa -->
<div class="space-y-4">
  <h1 class="text-2xl font-bold">{m.auth_handoff_confirm_heading()}</h1>
  <p class="text-sm text-slate-600">{m.auth_handoff_mfa_prompt()}</p>
  <MfaLoginForm {mfaToken} {onExpired} {onAuthenticated} /><InjectionPoint
    name="auth.handoff.mfa"
    {data}
  />
</div>
