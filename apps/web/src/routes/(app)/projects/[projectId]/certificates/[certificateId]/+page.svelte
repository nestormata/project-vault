<script lang="ts">
  import CertificateDetailContent from '$lib/components/monitoring/CertificateDetailContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{data.certificate?.domain ?? 'Certificate'} | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.certificates-detail.before" data={data?.__inject} />
<InjectionPoint name="project.certificates-detail.header.actions" data={data?.__inject} />
<!-- @region project.certificates-detail.content -->
<CertificateDetailContent {data}>
  <InjectionPoint name="project.certificates-detail.content" data={data?.__inject} />
</CertificateDetailContent>
<InjectionPoint name="project.certificates-detail.after" data={data?.__inject} />
