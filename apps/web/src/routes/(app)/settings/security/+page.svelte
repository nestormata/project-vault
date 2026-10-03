<script lang="ts">
  import NavLink from '$lib/navigation/NavLink.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { resolve } from '$app/paths'
  import MfaEnrollmentPanel from '$lib/components/settings/MfaEnrollmentPanel.svelte'
  import type { PageData } from './$types.js'

  const { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Security | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.security.before" data={data?.__inject} />
<InjectionPoint name="settings.security.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <div class="mb-8">
    <NavLink
      surface="back"
      node="back.settings.security"
      class="text-sm text-indigo-600 hover:text-indigo-800"
    />
    <h1 class="mt-2 text-2xl font-bold text-gray-900">Security</h1>
    <p class="text-gray-500">Manage multi-factor authentication for your account.</p>
  </div>

  <MfaEnrollmentPanel initialUser={data.user} />
</div>
<InjectionPoint name="settings.security.after" data={data?.__inject} />
