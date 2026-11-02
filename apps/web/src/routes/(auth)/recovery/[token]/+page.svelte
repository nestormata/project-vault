<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import RecoveryResetContent from '$lib/components/auth/RecoveryResetContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
</script>

<svelte:head>
  <title>Reset your password | {m.brand_name()}</title>
</svelte:head>

<InjectionPoint name="auth.recovery-detail.before" data={data?.__inject} />
<InjectionPoint name="auth.recovery-detail.header.actions" data={data?.__inject} />
<!-- @region auth.recovery-detail.content -->
<RecoveryResetContent data={data?.__inject}>
  <InjectionPoint name="auth.recovery-detail.content" data={data?.__inject} />
</RecoveryResetContent>
<InjectionPoint name="auth.recovery-detail.after" data={data?.__inject} />
