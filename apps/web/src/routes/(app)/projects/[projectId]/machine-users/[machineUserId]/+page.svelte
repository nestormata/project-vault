<script lang="ts">
  import MachineUserDetailContent from '$lib/components/machine-users/MachineUserDetailContent.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{data.machineUser?.name ?? 'Machine user'} | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.machine-users-detail.before" data={data?.__inject} />
<InjectionPoint name="project.machine-users-detail.header.actions" data={data?.__inject} />
<!-- @region project.machine-users-detail.content -->
<MachineUserDetailContent {data}>
  <InjectionPoint name="project.machine-users-detail.content" data={data?.__inject} />
</MachineUserDetailContent>
<InjectionPoint name="project.machine-users-detail.after" data={data?.__inject} />
