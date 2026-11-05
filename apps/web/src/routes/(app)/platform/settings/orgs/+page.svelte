<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import PlatformOrgsContent from '$lib/components/platform/PlatformOrgsContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Organizations | Platform Admin | {m.brand_name()}</title>
</svelte:head>

<InjectionPoint name="platform.settings-orgs.before" data={data?.__inject} />
<InjectionPoint name="platform.settings-orgs.header.actions" data={data?.__inject} />
<!-- @region platform.settings-orgs.content -->
<PlatformOrgsContent pageData={data} data={data?.__inject}>
  <InjectionPoint name="platform.settings-orgs.content" data={data?.__inject} />
</PlatformOrgsContent>
<InjectionPoint name="platform.settings-orgs.after" data={data?.__inject} />
