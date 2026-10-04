<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PublicStatusHeader from '$lib/components/public-status/PublicStatusHeader.svelte'
  import PublicStatusServices from '$lib/components/public-status/PublicStatusServices.svelte'
  import PublicStatusUnavailable from '$lib/components/public-status/PublicStatusUnavailable.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Status | Project Vault</title>
</svelte:head>

<InjectionPoint name="status.detail.before" data={data?.__inject} />
<InjectionPoint name="status.detail.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-2xl px-4 py-10">
  {#if data.statusPage}
    <PublicStatusHeader data={data.__inject} />
    <PublicStatusServices statusPage={data.statusPage} data={data.__inject} />
  {:else}
    <PublicStatusUnavailable data={data.__inject} />
  {/if}
</div>
<InjectionPoint name="status.detail.after" data={data?.__inject} />
