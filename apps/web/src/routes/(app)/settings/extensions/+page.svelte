<script lang="ts">
  import ExtensionsHeader from '$lib/components/settings/ExtensionsHeader.svelte'
  import ExtensionsStatusPanel from '$lib/components/settings/ExtensionsStatusPanel.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Extensions | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.extensions.before" data={data?.__inject} />
<InjectionPoint name="settings.extensions.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region settings.extensions.header -->
  <ExtensionsHeader>
    <InjectionPoint name="settings.extensions.header" data={data?.__inject} />
  </ExtensionsHeader>

  <!-- @region settings.extensions.status -->
  <ExtensionsStatusPanel
    allowed={data.allowed}
    mfaRequired={data.allowed ? data.mfaRequired : false}
    errorMessage={data.allowed ? data.errorMessage : null}
    manifest={data.allowed ? data.manifest : null}
    healthStatus={data.allowed ? data.healthStatus : null}
  >
    <InjectionPoint name="settings.extensions.status" data={data?.__inject} />
  </ExtensionsStatusPanel>
</div>
<InjectionPoint name="settings.extensions.after" data={data?.__inject} />
