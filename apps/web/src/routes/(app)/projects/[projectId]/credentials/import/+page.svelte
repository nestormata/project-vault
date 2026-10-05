<script lang="ts">
  import CredentialsProjectImportHeader from '$lib/components/credentials/CredentialsProjectImportHeader.svelte'
  import CredentialsProjectImportContent from '$lib/components/credentials/CredentialsProjectImportContent.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Import secrets | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.credentials-import.before" data={data?.__inject} />
<InjectionPoint name="project.credentials-import.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-3xl space-y-6">
  <!-- @region project.credentials-import.header -->
  <CredentialsProjectImportHeader>
    <InjectionPoint name="project.credentials-import.header" data={data?.__inject} />
  </CredentialsProjectImportHeader>

  <!-- @region project.credentials-import.content -->
  <CredentialsProjectImportContent {data}>
    <InjectionPoint name="project.credentials-import.content" data={data?.__inject} />
  </CredentialsProjectImportContent>
</section>
<InjectionPoint name="project.credentials-import.after" data={data?.__inject} />
