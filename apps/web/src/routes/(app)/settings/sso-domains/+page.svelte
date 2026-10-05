<script lang="ts">
  import SsoDomainsHeader from '$lib/components/settings/SsoDomainsHeader.svelte'
  import SsoDomainsPanel from '$lib/components/settings/SsoDomainsPanel.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>SSO Domains | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.sso-domains.before" data={data?.__inject} />
<InjectionPoint name="settings.sso-domains.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region settings.sso-domains.header -->
  <SsoDomainsHeader>
    <InjectionPoint name="settings.sso-domains.header" data={data?.__inject} />
  </SsoDomainsHeader>

  <!-- @region settings.sso-domains.panel -->
  <SsoDomainsPanel {data}>
    <InjectionPoint name="settings.sso-domains.panel" data={data?.__inject} />
  </SsoDomainsPanel>
</div>
<InjectionPoint name="settings.sso-domains.after" data={data?.__inject} />
