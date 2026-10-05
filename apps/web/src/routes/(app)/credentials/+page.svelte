<script lang="ts">
  import CredentialsHomeHeader from '$lib/components/credentials/CredentialsHomeHeader.svelte'
  import CredentialsHomeProjects from '$lib/components/credentials/CredentialsHomeProjects.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Secrets | Project Vault</title>
</svelte:head>

<InjectionPoint name="credentials.home.before" data={data?.__inject} />
<InjectionPoint name="credentials.home.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region credentials.home.header -->
  <CredentialsHomeHeader>
    <InjectionPoint name="credentials.home.header" data={data?.__inject} />
  </CredentialsHomeHeader>

  <!-- @region credentials.home.projects -->
  <CredentialsHomeProjects projects={data.projects.items}>
    <InjectionPoint name="credentials.home.projects" data={data?.__inject} />
  </CredentialsHomeProjects>
</section>
<InjectionPoint name="credentials.home.after" data={data?.__inject} />
