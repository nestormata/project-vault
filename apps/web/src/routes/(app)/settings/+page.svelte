<script lang="ts">
  import SettingsHomeHeader from '$lib/components/settings/SettingsHomeHeader.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
  import NavCardsRegion from '$lib/components/shell/NavCardsRegion.svelte'
</script>

<svelte:head>
  <title>Settings | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.home.before" data={data?.__inject} />
<InjectionPoint name="settings.home.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region settings.home.header -->
  <SettingsHomeHeader>
    <InjectionPoint name="settings.home.header" data={data?.__inject} />
  </SettingsHomeHeader>

  <!-- @region settings.home.nav-cards -->
  <NavCardsRegion surface="settings.index">
    <InjectionPoint name="settings.home.nav-cards" data={data?.__inject} />
  </NavCardsRegion>
</div>
<InjectionPoint name="settings.home.after" data={data?.__inject} />
