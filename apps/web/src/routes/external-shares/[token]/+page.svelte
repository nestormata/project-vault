<script lang="ts">
  import SharedSecretHeading from '$lib/components/public/SharedSecretHeading.svelte'
  import ExternalShareBody from '$lib/components/public/ExternalShareBody.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>Shared secret</title>
</svelte:head>

<InjectionPoint name="external-shares.detail.before" data={data?.__inject} />
<InjectionPoint name="external-shares.detail.header.actions" data={data?.__inject} />
<!--
  Story 17.2 AC-10 (F1): no third-party-origin resources anywhere on this page — no external
  images/fonts/scripts/analytics/embeds. Referrer-Policy alone only governs this page's own
  outbound requests; a same-origin-only resource set is the only way to guarantee zero leak
  surface for the token-bearing URL.
-->
<section class="mx-auto max-w-lg space-y-6 p-6">
  <!-- @region external-shares.detail.heading -->
  <SharedSecretHeading>
    <InjectionPoint name="external-shares.detail.heading" data={data?.__inject} />
  </SharedSecretHeading>

  <!-- @region external-shares.detail.body -->
  <ExternalShareBody metadata={data.metadata} token={data.token} error={data.error}>
    <InjectionPoint name="external-shares.detail.body" data={data?.__inject} />
  </ExternalShareBody>
</section>
<InjectionPoint name="external-shares.detail.after" data={data?.__inject} />
