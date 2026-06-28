<script lang="ts">
  import { resolve } from '$app/paths'
  import RegisterForm from '$lib/components/auth/RegisterForm.svelte'
</script>

<svelte:head>
  <title>Register | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  <div class="space-y-2">
    <h1 class="text-3xl font-bold">Register</h1>
    <p class="text-slate-600">Create the first organization account for this vault.</p>
  </div>
  <RegisterForm />
  <p class="text-sm text-slate-600">
    Already have an account? <a
      class="font-medium text-slate-950 underline"
      href={resolve('/login')}>Sign in</a
    >
  </p>
</div>
