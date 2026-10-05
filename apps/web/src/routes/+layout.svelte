<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import '../app.css'
  import RootLayoutBody from '$lib/components/shell/RootLayoutBody.svelte'
  import RootLayoutProgress from '$lib/components/shell/RootLayoutProgress.svelte'
  const { children, data }: { children: import('svelte').Snippet; data?: App.PageData } = $props()
</script>

<svelte:head>
  <InjectionPoint name="shell.head" data={data?.__inject} />
</svelte:head>

<!-- @region root.layout.progress -->
<RootLayoutProgress>
  <InjectionPoint name="root.layout.progress" data={data?.__inject} />
</RootLayoutProgress>
<InjectionPoint name="root.layout.before" data={data?.__inject} />
<InjectionPoint name="root.layout.header.actions" data={data?.__inject} />
<!-- @region root.layout.body -->
<RootLayoutBody body={children}>
  <InjectionPoint name="root.layout.body" data={data?.__inject} />
</RootLayoutBody>
<InjectionPoint name="root.layout.after" data={data?.__inject} />
<InjectionPoint name="shell.body.end" data={data?.__inject} />
