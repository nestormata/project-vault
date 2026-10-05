<script lang="ts">
  import SecurityHeader from '$lib/components/settings/SecurityHeader.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

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
  <!-- @region settings.security.header -->
  <SecurityHeader>
    <InjectionPoint name="settings.security.header" data={data?.__inject} />
  </SecurityHeader>

  <MfaEnrollmentPanel initialUser={data.user} />
</div>
<InjectionPoint name="settings.security.after" data={data?.__inject} />
