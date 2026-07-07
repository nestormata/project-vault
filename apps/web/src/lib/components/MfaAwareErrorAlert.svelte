<!--
  Inline error alert used for rotation/member mutation failures. Renders nothing when `message`
  is falsy. When the message text mentions "MFA" (the mfa_required mapping from
  rotation-copy.ts / equivalent member-management copy), an "Enable MFA" link to the security
  settings page is appended — this is the one bit of behavior shared verbatim across
  BreakGlassPanel, StaleRecoveryBanner, and the project members page, so it lives here once
  instead of being copy-pasted into each.
-->
<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    message,
    class: className,
  }: {
    message: string | null
    class: string
  } = $props()
</script>

{#if message}
  <p class={className} role="alert">
    {message}
    {#if message.includes('MFA')}
      <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
    {/if}
  </p>
{/if}
