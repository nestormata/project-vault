<script lang="ts">
  import CredentialsListHeader from '$lib/components/credentials/CredentialsListHeader.svelte'
  import CredentialsListContent from '$lib/components/credentials/CredentialsListContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import { canCreateCredential } from '$lib/components/onboarding/onboarding-logic.js'
  import { canImportCredentials } from '$lib/credentials/permissions.js'

  let { data } = $props()

  const canCreate = $derived(canCreateCredential(data.orgRole))
  const canImport = $derived(canImportCredentials(data.orgRole))
</script>

<svelte:head>
  <title>Secrets | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.credentials.before" data={data?.__inject} />
<InjectionPoint name="project.credentials.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region project.credentials.header -->
  <CredentialsListHeader {canCreate} {canImport} projectId={data.projectId}>
    <InjectionPoint name="project.credentials.header" data={data?.__inject} />
  </CredentialsListHeader>

  <!-- @region project.credentials.list -->
  <CredentialsListContent {data} {canCreate}>
    <InjectionPoint name="project.credentials.list" data={data?.__inject} />
  </CredentialsListContent>
</section>
<InjectionPoint name="project.credentials.after" data={data?.__inject} />
