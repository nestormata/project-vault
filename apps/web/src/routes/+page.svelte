<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import RootHomeContent from '$lib/components/public/RootHomeContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
</script>

<svelte:head>
  <title>{m.brand_name()}</title>
</svelte:head>

<InjectionPoint name="root.home.before" data={data?.__inject} />
<InjectionPoint name="root.home.header.actions" data={data?.__inject} />
<!-- @region root.home.content -->
<RootHomeContent>
  <InjectionPoint name="root.home.content" data={data?.__inject} />
</RootHomeContent>
<InjectionPoint name="root.home.after" data={data?.__inject} />
