<script lang="ts">
  import { resolve } from '$app/paths'
  import MfaEnrollmentPanel from '$lib/components/settings/MfaEnrollmentPanel.svelte'
  import type { PageData } from './$types.js'

  const { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Security | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <div class="mb-8">
    <a href={resolve('/settings')} class="text-sm text-indigo-600 hover:text-indigo-800"
      >← Settings</a
    >
    <h1 class="mt-2 text-2xl font-bold text-gray-900">Security</h1>
    <p class="text-gray-500">Manage multi-factor authentication for your account.</p>
  </div>

  <MfaEnrollmentPanel initialUser={data.user} />
</div>
