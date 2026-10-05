<script lang="ts">
  import CertificatesNewHeader from '$lib/components/monitoring/CertificatesNewHeader.svelte'
  import CertificatesNewForm from '$lib/components/monitoring/CertificatesNewForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>New certificate | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.certificates-new.before" data={data?.__inject} />
<InjectionPoint name="project.certificates-new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.certificates-new.header -->
  <CertificatesNewHeader>
    <InjectionPoint name="project.certificates-new.header" data={data?.__inject} />
  </CertificatesNewHeader>

  <!-- @region project.certificates-new.form -->
  <CertificatesNewForm {data}>
    <InjectionPoint name="project.certificates-new.form" data={data?.__inject} />
  </CertificatesNewForm>
</section>
<InjectionPoint name="project.certificates-new.after" data={data?.__inject} />
