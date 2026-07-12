<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import LoginForm from '$lib/components/auth/LoginForm.svelte'
  import { getLoginReasonMessage } from '$lib/security/hardening.js'

  // Only allow same-origin relative paths — a bare "/x" is safe, "//evil.com" or an absolute
  // URL is not (browsers treat "//" as protocol-relative, i.e. an external redirect).
  function safeNextPath(raw: string | null): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
    return raw
  }

  let message = $derived(getLoginReasonMessage(page.url.searchParams.get('reason')))
  let nextPath = $derived(safeNextPath(page.url.searchParams.get('next')))
</script>

<svelte:head>
  <title>Sign in | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  <div class="space-y-2">
    <h1 class="text-3xl font-bold">Sign in</h1>
    <p class="text-slate-600">Use your Project Vault account to continue.</p>
  </div>
  {#if message}
    <p class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      {message}
    </p>
  {/if}
  <LoginForm {nextPath} />
  <p class="text-sm text-slate-600">
    Need an account? <a class="font-medium text-brand-600 underline" href={resolve('/register')}
      >Register</a
    >
  </p>
  <p class="text-sm text-slate-600">
    <a class="font-medium text-brand-600 underline" href={resolve('/recovery')}
      >Can't access your account?</a
    >
  </p>
</div>
