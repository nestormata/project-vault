<script lang="ts">
  import AuditForwardingHeader from '$lib/components/settings/AuditForwardingHeader.svelte'
  import AuditForwardingPanel from '$lib/components/settings/AuditForwardingPanel.svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Forwarding & Retention | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.audit-forwarding.before" data={data?.__inject} />
<InjectionPoint name="settings.audit-forwarding.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region settings.audit-forwarding.header -->
  <AuditForwardingHeader>
    <InjectionPoint name="settings.audit-forwarding.header" data={data?.__inject} />
  </AuditForwardingHeader>
  <NavLink
    surface="back"
    node="back.settings.audit.forwarding"
    class="mt-2 inline-block text-sm text-indigo-600 underline"
  />

  <!-- @region settings.audit-forwarding.config -->
  <AuditForwardingPanel {data}>
    <InjectionPoint name="settings.audit-forwarding.config" data={data?.__inject} />
  </AuditForwardingPanel>
</div>
<InjectionPoint name="settings.audit-forwarding.after" data={data?.__inject} />
