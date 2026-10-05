<script lang="ts">
  import InvitationAcceptContent from '$lib/components/auth/InvitationAcceptContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
</script>

<svelte:head>
  <title>Accept invitation | Project Vault</title>
</svelte:head>

<InjectionPoint name="auth.invitations-accept.before" data={data?.__inject} />
<InjectionPoint name="auth.invitations-accept.header.actions" data={data?.__inject} />
<!-- @region auth.invitations-accept.content -->
<InvitationAcceptContent>
  <InjectionPoint name="auth.invitations-accept.content" data={data?.__inject} />
</InvitationAcceptContent>
<InjectionPoint name="auth.invitations-accept.after" data={data?.__inject} />
