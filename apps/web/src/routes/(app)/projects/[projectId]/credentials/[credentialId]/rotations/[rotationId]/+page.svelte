<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import RotationDetailContent from '$lib/components/rotations/RotationDetailContent.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<InjectionPoint name="project.credentials-rotations-detail.before" data={data?.__inject} />
<InjectionPoint name="project.credentials-rotations-detail.header.actions" data={data?.__inject} />

<svelte:head>
  <title>Rotation | {m.brand_name()}</title>
</svelte:head>

<!-- @region project.credentials-rotations-detail.content -->
<RotationDetailContent pageData={data} data={data?.__inject}>
  <InjectionPoint name="project.credentials-rotations-detail.content" data={data?.__inject} />
</RotationDetailContent>
<InjectionPoint name="project.credentials-rotations-detail.after" data={data?.__inject} />
