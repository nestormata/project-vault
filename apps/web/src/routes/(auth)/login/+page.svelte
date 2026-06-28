<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import LoginForm from '$lib/components/auth/LoginForm.svelte'
  import { getLoginReasonMessage } from '$lib/security/hardening.js'

  let message = $derived(getLoginReasonMessage(page.url.searchParams.get('reason')))
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
  <LoginForm />
  <p class="text-sm text-slate-600">
    Need an account? <a class="font-medium text-slate-950 underline" href={resolve('/register')}
      >Register</a
    >
  </p>
</div>
