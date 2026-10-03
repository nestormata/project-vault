<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
  import NavCards from '$lib/navigation/NavCards.svelte'
</script>

<svelte:head>
  <title>Settings | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.home.before" data={data?.__inject} />
<InjectionPoint name="settings.home.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Settings</h1>
  <p class="mt-2 text-gray-500">Manage your vault preferences.</p>

  <NavCards surface="settings.index" />
</div>
<InjectionPoint name="settings.home.after" data={data?.__inject} />
