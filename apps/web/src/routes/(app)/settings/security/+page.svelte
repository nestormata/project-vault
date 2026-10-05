<script lang="ts">
  import SecurityHeader from '$lib/components/settings/SecurityHeader.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import SecurityEnrollmentRegion from '$lib/components/settings/SecurityEnrollmentRegion.svelte'
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

  <!-- @region settings.security.enrollment -->
  <SecurityEnrollmentRegion initialUser={data.user}>
    <InjectionPoint name="settings.security.enrollment" data={data?.__inject} />
  </SecurityEnrollmentRegion>
</div>
<InjectionPoint name="settings.security.after" data={data?.__inject} />
