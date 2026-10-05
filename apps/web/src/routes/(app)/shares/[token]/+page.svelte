<script lang="ts">
  import SharedSecretHeading from '$lib/components/public/SharedSecretHeading.svelte'
  import ShareBody from '$lib/components/public/ShareBody.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Shared secret</title>
</svelte:head>

<InjectionPoint name="shares.detail.before" data={data?.__inject} />
<InjectionPoint name="shares.detail.header.actions" data={data?.__inject} />
<section class="mx-auto max-w-lg space-y-6 p-6">
  <!-- @region shares.detail.heading -->
  <SharedSecretHeading>
    <InjectionPoint name="shares.detail.heading" data={data?.__inject} />
  </SharedSecretHeading>

  <!-- @region shares.detail.body -->
  <ShareBody metadata={data.metadata} token={data.token} error={data.error}>
    <InjectionPoint name="shares.detail.body" data={data?.__inject} />
  </ShareBody>
</section>
<InjectionPoint name="shares.detail.after" data={data?.__inject} />
