<script lang="ts">
  import PlatformResourceUsageContent from '$lib/components/platform/PlatformResourceUsageContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Resource Usage | Platform Admin | Project Vault</title>
</svelte:head>

<InjectionPoint name="platform.settings-resource-usage.before" data={data?.__inject} />
<InjectionPoint name="platform.settings-resource-usage.header.actions" data={data?.__inject} />
<!-- @region platform.settings-resource-usage.content -->
<PlatformResourceUsageContent {data}>
  <InjectionPoint name="platform.settings-resource-usage.content" data={data?.__inject} />
</PlatformResourceUsageContent>
<InjectionPoint name="platform.settings-resource-usage.after" data={data?.__inject} />
