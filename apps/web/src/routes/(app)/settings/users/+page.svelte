<script lang="ts">
  import UsersHeader from '$lib/components/settings/UsersHeader.svelte'
  import UsersManagementPanel from '$lib/components/settings/UsersManagementPanel.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<InjectionPoint name="settings.users.before" data={data?.__inject} />
<InjectionPoint name="settings.users.header.actions" data={data?.__inject} />

<svelte:head>
  <title>Users | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
  <!-- @region settings.users.header -->
  <UsersHeader>
    <InjectionPoint name="settings.users.header" data={data?.__inject} />
  </UsersHeader>

  <!-- @region settings.users.management -->
  <UsersManagementPanel {data}>
    <InjectionPoint name="settings.users.management" data={data?.__inject} />
  </UsersManagementPanel>
</div>
<InjectionPoint name="settings.users.after" data={data?.__inject} />
