<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import RegisterForm from '$lib/components/auth/RegisterForm.svelte'

  let invitationToken = $derived(page.url.searchParams.get('invitationToken') ?? undefined)
  let prefillEmail = $derived(page.url.searchParams.get('email') ?? '')
</script>

<svelte:head>
  <title>Register | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  <div class="space-y-2">
    <h1 class="text-3xl font-bold">Register</h1>
    <p class="text-slate-600">
      {invitationToken
        ? "You don't have an account yet — create one to join the project."
        : 'Create the first organization account for this vault.'}
    </p>
  </div>
  <RegisterForm {invitationToken} {prefillEmail} />
  <p class="text-sm text-slate-600">
    Already have an account? <a
      class="font-medium text-slate-950 underline"
      href={resolve('/login')}>Sign in</a
    >
  </p>
</div>
