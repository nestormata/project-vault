<script lang="ts">
  import StatusPageContent from '$lib/components/public/StatusPageContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Status | Project Vault</title>
</svelte:head>

<InjectionPoint name="status.detail.before" data={data?.__inject} />
<InjectionPoint name="status.detail.header.actions" data={data?.__inject} />
<!-- @region status.detail.content -->
<StatusPageContent statusPage={data.statusPage}>
  <InjectionPoint name="status.detail.content" data={data?.__inject} />
</StatusPageContent>
<InjectionPoint name="status.detail.after" data={data?.__inject} />
