<script lang="ts">
  import PlatformSettingsContent from '$lib/components/platform/PlatformSettingsContent.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>System Settings | Platform Admin | Project Vault</title>
</svelte:head>

<InjectionPoint name="platform.settings.before" data={data?.__inject} />
<InjectionPoint name="platform.settings.header.actions" data={data?.__inject} />
<!-- @region platform.settings.content -->
<PlatformSettingsContent {data}>
  <InjectionPoint name="platform.settings.content" data={data?.__inject} />
</PlatformSettingsContent>
<InjectionPoint name="platform.settings.after" data={data?.__inject} />
