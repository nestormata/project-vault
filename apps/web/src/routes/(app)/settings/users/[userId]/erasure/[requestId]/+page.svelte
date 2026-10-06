<script lang="ts">
  import ErasureHeader from '$lib/components/settings/ErasureHeader.svelte'
  import ErasureRequestPanel from '$lib/components/settings/ErasureRequestPanel.svelte'
  import NavLinkRegion from '$lib/components/shell/NavLinkRegion.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Erasure Request | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.users-erasure-detail.before" data={data?.__inject} />
<InjectionPoint name="settings.users-erasure-detail.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region settings.users-erasure-detail.header -->
  <ErasureHeader>
    <InjectionPoint name="settings.users-erasure-detail.header" data={data?.__inject} />
  </ErasureHeader>
  <!-- @region settings.users-erasure-detail.back -->
  <NavLinkRegion
    surface="back"
    node="back.settings.users.erasure"
    class="mt-2 inline-block text-sm text-indigo-600 underline"
  >
    <InjectionPoint name="settings.users-erasure-detail.back" data={data?.__inject} />
  </NavLinkRegion>

  <!-- @region settings.users-erasure-detail.request -->
  <ErasureRequestPanel {data}>
    <InjectionPoint name="settings.users-erasure-detail.request" data={data?.__inject} />
  </ErasureRequestPanel>
</div>
<InjectionPoint name="settings.users-erasure-detail.after" data={data?.__inject} />
