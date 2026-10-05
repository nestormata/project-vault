<script lang="ts">
  import MachineUsersListHeader from '$lib/components/machine-users/MachineUsersListHeader.svelte'
  import MachineUsersListContent from '$lib/components/machine-users/MachineUsersListContent.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import { canManageMachineUsers } from '$lib/machine-users/permissions.js'

  let { data } = $props()

  const canManage = $derived(canManageMachineUsers(data.orgRole))
</script>

<svelte:head>
  <title>Machine users | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.machine-users.before" data={data?.__inject} />
<InjectionPoint name="project.machine-users.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region project.machine-users.header -->
  <MachineUsersListHeader {canManage} projectId={data.projectId}>
    <InjectionPoint name="project.machine-users.header" data={data?.__inject} />
  </MachineUsersListHeader>

  <!-- @region project.machine-users.list -->
  <MachineUsersListContent {data} {canManage}>
    <InjectionPoint name="project.machine-users.list" data={data?.__inject} />
  </MachineUsersListContent>
</section>
<InjectionPoint name="project.machine-users.after" data={data?.__inject} />
