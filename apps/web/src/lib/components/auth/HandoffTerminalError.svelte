<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import HandoffReturnGuidance from './HandoffReturnGuidance.svelte'

  // Story 60.4 AC2/AC3 (F11): every terminal error state (no-params/malformed, rejected, and
  // login_failed) shares this block — an error heading instead of "Confirm sign-in", the alert, and
  // guidance back to CentralizeMe. The guidance is deliberately outside the role="alert" element
  // (the alert announces the error; this is follow-up help) and is never a retry action on PV.
  // Story 69.11: one sub-region for all three states.
  let {
    message,
    centralizeMeOrigin,
    data,
  }: {
    message: string | null
    centralizeMeOrigin: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region auth.handoff.error -->
<div class="space-y-2">
  <h1 class="text-2xl font-bold">{m.auth_handoff_error_heading()}</h1>
  <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
    {message}
  </p>
  <HandoffReturnGuidance {centralizeMeOrigin} /><InjectionPoint name="auth.handoff.error" {data} />
</div>
