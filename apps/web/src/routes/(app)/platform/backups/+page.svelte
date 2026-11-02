<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import PlatformBackupsContent from '$lib/components/platform/PlatformBackupsContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Backups | Platform Admin | {m.brand_name()}</title>
</svelte:head>

<InjectionPoint name="platform.backups.before" data={data?.__inject} />
<InjectionPoint name="platform.backups.header.actions" data={data?.__inject} />
<!-- @region platform.backups.content -->
<PlatformBackupsContent pageData={data} data={data.__inject}>
  <InjectionPoint name="platform.backups.content" data={data?.__inject} />
</PlatformBackupsContent>
<InjectionPoint name="platform.backups.after" data={data?.__inject} />
