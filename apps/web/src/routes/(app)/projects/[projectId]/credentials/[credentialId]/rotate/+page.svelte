<script lang="ts">
  import CredentialRotateHeader from '$lib/components/credentials/CredentialRotateHeader.svelte'
  import CredentialRotateForm from '$lib/components/credentials/CredentialRotateForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Start rotation | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.credentials-rotate.before" data={data?.__inject} />
<InjectionPoint name="project.credentials-rotate.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.credentials-rotate.header -->
  <CredentialRotateHeader>
    <InjectionPoint name="project.credentials-rotate.header" data={data?.__inject} />
  </CredentialRotateHeader>

  <!-- @region project.credentials-rotate.form -->
  <CredentialRotateForm {data}>
    <InjectionPoint name="project.credentials-rotate.form" data={data?.__inject} />
  </CredentialRotateForm>
</section>
<InjectionPoint name="project.credentials-rotate.after" data={data?.__inject} />
