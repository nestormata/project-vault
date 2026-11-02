<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import DomainDetailContent from '$lib/components/monitoring/DomainDetailContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{data.domain?.domainName ?? 'Domain'} | {m.brand_name()}</title>
</svelte:head>

<InjectionPoint name="project.domains-detail.before" data={data?.__inject} />
<InjectionPoint name="project.domains-detail.header.actions" data={data?.__inject} />
<!-- @region project.domains-detail.content -->
<DomainDetailContent {data}>
  <InjectionPoint name="project.domains-detail.content" data={data?.__inject} />
</DomainDetailContent>
<InjectionPoint name="project.domains-detail.after" data={data?.__inject} />
