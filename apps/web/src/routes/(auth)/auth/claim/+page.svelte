<script lang="ts">
  import HandoffClaimContent from '$lib/components/auth/HandoffClaimContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import { m } from '$lib/paraglide/messages.js'

  // Story 73.1: where the issuer sends the browser back with the token in the URL fragment. The
  // load returns only `centralizeMeOrigin` (server-side config); `data` is optional so the page
  // still renders, with plain-text guidance, when no load data is supplied.
  let {
    data,
  }: {
    data?: { centralizeMeOrigin?: string | null; __inject?: App.PageData['__inject'] }
  } = $props()
  let centralizeMeOrigin = $derived(data?.centralizeMeOrigin ?? null)
</script>

<InjectionPoint name="auth.handoff.before" data={data?.__inject} />
<InjectionPoint name="auth.handoff.header.actions" data={data?.__inject} />
<!-- @region auth.handoff.content -->
<HandoffClaimContent {centralizeMeOrigin} data={data?.__inject}>
  <InjectionPoint name="auth.handoff.content" data={data?.__inject} />
</HandoffClaimContent>
<InjectionPoint name="auth.handoff.after" data={data?.__inject} />

<svelte:head>
  <title>{m.auth_handoff_page_title()}</title>
</svelte:head>
