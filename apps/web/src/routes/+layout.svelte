<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import '../app.css'
  import NavigationProgressBar from '$lib/components/NavigationProgressBar.svelte'
  const { children, data }: { children: import('svelte').Snippet; data?: App.PageData } = $props()
</script>

<svelte:head>
  <InjectionPoint name="shell.head" data={data?.__inject} />
</svelte:head>

<NavigationProgressBar />
<InjectionPoint name="root.layout.before" data={data?.__inject} />
<InjectionPoint name="root.layout.header.actions" data={data?.__inject} />
{@render children()}
<InjectionPoint name="root.layout.after" data={data?.__inject} />
<InjectionPoint name="shell.body.end" data={data?.__inject} />
