<script lang="ts">
  import CredentialsImportHeader from '$lib/components/credentials/CredentialsImportHeader.svelte'
  import CredentialsImportProjects from '$lib/components/credentials/CredentialsImportProjects.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Import secrets | Project Vault</title>
</svelte:head>

<InjectionPoint name="credentials.import.before" data={data?.__inject} />
<InjectionPoint name="credentials.import.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region credentials.import.header -->
  <CredentialsImportHeader>
    <InjectionPoint name="credentials.import.header" data={data?.__inject} />
  </CredentialsImportHeader>

  <!-- @region credentials.import.projects -->
  <CredentialsImportProjects canImport={data.canImport} projects={data.projects.items}>
    <InjectionPoint name="credentials.import.projects" data={data?.__inject} />
  </CredentialsImportProjects>
</section>
<InjectionPoint name="credentials.import.after" data={data?.__inject} />
