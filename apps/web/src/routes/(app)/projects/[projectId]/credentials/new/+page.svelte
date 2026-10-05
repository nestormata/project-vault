<script lang="ts">
  import CredentialsNewHeader from '$lib/components/credentials/CredentialsNewHeader.svelte'
  import CredentialsNewForm from '$lib/components/credentials/CredentialsNewForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>New secret | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.credentials-new.before" data={data?.__inject} />
<InjectionPoint name="project.credentials-new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.credentials-new.header -->
  <CredentialsNewHeader>
    <InjectionPoint name="project.credentials-new.header" data={data?.__inject} />
  </CredentialsNewHeader>

  <!-- @region project.credentials-new.form -->
  <CredentialsNewForm {data}>
    <InjectionPoint name="project.credentials-new.form" data={data?.__inject} />
  </CredentialsNewForm>
</section>
<InjectionPoint name="project.credentials-new.after" data={data?.__inject} />
