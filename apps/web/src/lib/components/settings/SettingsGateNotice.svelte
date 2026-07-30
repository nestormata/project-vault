<!--
  Shared by every org-admin-gated /settings/* page's permission-denied and MFA-required states
  (sso-domains, external-identities, ...) — the markup itself is deliberately identical across
  siblings (per this epic's own multi-state-page convention), so it lives here once instead of
  being copy-pasted per page (jscpd zero-duplication gate).

  Story 18.1 AC-1: `href` must already be the output of `resolve(...)` — resolved once at the
  call site, matching the literal-anchor convention used elsewhere (e.g. settings/+page.svelte).
  This component does not call `resolve()` itself, so callers can no longer pass a raw string.
-->
<script lang="ts">
  import type { resolve } from '$app/paths'

  let {
    variant,
    message,
    href,
    linkText,
  }: {
    variant: 'denied' | 'mfa'
    message: string
    href: ReturnType<typeof resolve>
    linkText: string
  } = $props()
</script>

{#if variant === 'denied'}
  <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
    <p class="text-slate-600">{message}</p>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href is already resolve()'s output, resolved once by the caller (Story 18.1 AC-1). -->
    <a {href} class="mt-2 inline-block text-sm text-indigo-600 underline">{linkText}</a>
  </div>
{:else}
  <div class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6">
    <p class="text-amber-900">{message}</p>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href is already resolve()'s output, resolved once by the caller (Story 18.1 AC-1). -->
    <a {href} class="mt-2 inline-block text-sm font-medium text-indigo-600 underline">{linkText}</a>
  </div>
{/if}
