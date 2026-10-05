<script lang="ts">
  import PlatformUpgradeContent from '$lib/components/platform/PlatformUpgradeContent.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Version & Upgrade | Platform Admin | Project Vault</title>
</svelte:head>

<InjectionPoint name="platform.upgrade.before" data={data?.__inject} />
<InjectionPoint name="platform.upgrade.header.actions" data={data?.__inject} />
<!-- @region platform.upgrade.content -->
<PlatformUpgradeContent {data}>
  <InjectionPoint name="platform.upgrade.content" data={data?.__inject} />
</PlatformUpgradeContent>
<InjectionPoint name="platform.upgrade.after" data={data?.__inject} />
