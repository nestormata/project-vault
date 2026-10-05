<script lang="ts">
  import ExtensionPanelContent from '$lib/components/extensions/ExtensionPanelContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Extension | Project Vault</title>
</svelte:head>

<InjectionPoint name="extensions.panels-detail.before" data={data?.__inject} />
<InjectionPoint name="extensions.panels-detail.header.actions" data={data?.__inject} />
<!-- @region extensions.panels-detail.content -->
<ExtensionPanelContent {data}>
  <InjectionPoint name="extensions.panels-detail.content" data={data?.__inject} />
</ExtensionPanelContent>
<InjectionPoint name="extensions.panels-detail.after" data={data?.__inject} />
