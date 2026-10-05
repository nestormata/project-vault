<script lang="ts">
  import RecoveryHeading from '$lib/components/auth/RecoveryHeading.svelte'
  import RecoveryRequestPanel from '$lib/components/auth/RecoveryRequestPanel.svelte'
  import RecoveryLoginLink from '$lib/components/auth/RecoveryLoginLink.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
</script>

<svelte:head>
  <title>Recover your account | Project Vault</title>
</svelte:head>

<InjectionPoint name="auth.recovery.before" data={data?.__inject} />
<InjectionPoint name="auth.recovery.header.actions" data={data?.__inject} />
<div class="space-y-6">
  <!-- @region auth.recovery.heading -->
  <RecoveryHeading>
    <InjectionPoint name="auth.recovery.heading" data={data?.__inject} />
  </RecoveryHeading>

  <!-- @region auth.recovery.request -->
  <RecoveryRequestPanel>
    <InjectionPoint name="auth.recovery.request" data={data?.__inject} />
  </RecoveryRequestPanel>

  <!-- @region auth.recovery.login-link -->
  <RecoveryLoginLink>
    <InjectionPoint name="auth.recovery.login-link" data={data?.__inject} />
  </RecoveryLoginLink>
</div>
<InjectionPoint name="auth.recovery.after" data={data?.__inject} />
