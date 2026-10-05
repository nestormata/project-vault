<script lang="ts">
  import RotationDetailContent from '$lib/components/rotations/RotationDetailContent.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<InjectionPoint name="project.credentials-rotations-detail.before" data={data?.__inject} />
<InjectionPoint name="project.credentials-rotations-detail.header.actions" data={data?.__inject} />

<svelte:head>
  <title>Rotation | Project Vault</title>
</svelte:head>

<!-- @region project.credentials-rotations-detail.content -->
<RotationDetailContent {data}>
  <InjectionPoint name="project.credentials-rotations-detail.content" data={data?.__inject} />
</RotationDetailContent>
<InjectionPoint name="project.credentials-rotations-detail.after" data={data?.__inject} />
