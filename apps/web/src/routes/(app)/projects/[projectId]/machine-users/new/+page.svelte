<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import MachineUsersNewHeader from '$lib/components/machine-users/MachineUsersNewHeader.svelte'
  import MachineUsersNewForm from '$lib/components/machine-users/MachineUsersNewForm.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>New machine user | {m.brand_name()}</title>
</svelte:head>

<InjectionPoint name="project.machine-users-new.before" data={data?.__inject} />
<InjectionPoint name="project.machine-users-new.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-2xl space-y-6">
  <!-- @region project.machine-users-new.header -->
  <MachineUsersNewHeader>
    <InjectionPoint name="project.machine-users-new.header" data={data?.__inject} />
  </MachineUsersNewHeader>

  <!-- @region project.machine-users-new.form -->
  <MachineUsersNewForm pageData={data} data={data?.__inject}>
    <InjectionPoint name="project.machine-users-new.form" data={data?.__inject} />
  </MachineUsersNewForm>
</section>
<InjectionPoint name="project.machine-users-new.after" data={data?.__inject} />
