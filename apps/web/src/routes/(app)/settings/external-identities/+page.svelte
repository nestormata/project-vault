<script lang="ts">
  import ExternalIdentitiesHeader from '$lib/components/settings/ExternalIdentitiesHeader.svelte'
  import ExternalIdentitiesPanel from '$lib/components/settings/ExternalIdentitiesPanel.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>External Identities | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.external-identities.before" data={data?.__inject} />
<InjectionPoint name="settings.external-identities.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region settings.external-identities.header -->
  <ExternalIdentitiesHeader>
    <InjectionPoint name="settings.external-identities.header" data={data?.__inject} />
  </ExternalIdentitiesHeader>

  <!-- @region settings.external-identities.panel -->
  <ExternalIdentitiesPanel {data}>
    <InjectionPoint name="settings.external-identities.panel" data={data?.__inject} />
  </ExternalIdentitiesPanel>
</div>
<InjectionPoint name="settings.external-identities.after" data={data?.__inject} />
