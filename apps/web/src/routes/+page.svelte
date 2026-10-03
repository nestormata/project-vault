<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
  const title = 'Project Vault'
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<InjectionPoint name="root.home.before" data={data?.__inject} />
<InjectionPoint name="root.home.header.actions" data={data?.__inject} />
<main class="container mx-auto p-8">
  <h1 class="text-4xl font-bold">Project Vault</h1>
  <p class="mt-4 text-gray-600">Run complex projects. Miss nothing.</p>
</main>
<InjectionPoint name="root.home.after" data={data?.__inject} />
