<script lang="ts">
  import PlatformAuditContent from '$lib/components/platform/PlatformAuditContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Platform Operator Audit Log | Platform Admin | Project Vault</title>
</svelte:head>

<InjectionPoint name="platform.audit.before" data={data?.__inject} />
<InjectionPoint name="platform.audit.header.actions" data={data?.__inject} />
<!-- @region platform.audit.content -->
<PlatformAuditContent {data}>
  <InjectionPoint name="platform.audit.content" data={data?.__inject} />
</PlatformAuditContent>
<InjectionPoint name="platform.audit.after" data={data?.__inject} />
