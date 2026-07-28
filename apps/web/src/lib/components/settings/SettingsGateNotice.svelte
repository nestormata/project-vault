<!--
  Shared by every org-admin-gated /settings/* page's permission-denied and MFA-required states
  (sso-domains, external-identities, ...) — the markup itself is deliberately identical across
  siblings (per this epic's own multi-state-page convention), so it lives here once instead of
  being copy-pasted per page (jscpd zero-duplication gate).
-->
<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    variant,
    message,
    href,
    linkText,
  }: {
    variant: 'denied' | 'mfa'
    message: string
    href: Parameters<typeof resolve>[0]
    linkText: string
  } = $props()
</script>

{#if variant === 'denied'}
  <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
    <p class="text-slate-600">{message}</p>
    <a href={resolve(href)} class="mt-2 inline-block text-sm text-indigo-600 underline"
      >{linkText}</a
    >
  </div>
{:else}
  <div class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6">
    <p class="text-amber-900">{message}</p>
    <a href={resolve(href)} class="mt-2 inline-block text-sm font-medium text-indigo-600 underline"
      >{linkText}</a
    >
  </div>
{/if}
