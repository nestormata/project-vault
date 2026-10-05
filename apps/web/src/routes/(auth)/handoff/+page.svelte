<script lang="ts">
  import HandoffConfirmContent from '$lib/components/auth/HandoffConfirmContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import { m } from '$lib/paraglide/messages.js'

  // Story 30.5 Task 1/AC1: this page follows `login/+page.svelte`'s existing precedent (Dev
  // Notes) of reading `page.url.searchParams` directly in the component rather than adding a
  // `+page.ts`/`+page.server.ts` `load` — the validation here is trivial (shape checks only, no
  // server-only data needed) and every other `(auth)` query-param-driven page already does this
  // inline. Documented here as a deliberate choice.
  // Story 60.3 later added a `+page.server.ts` `load` for the claim exchange; Story 60.4 has it
  // return `centralizeMeOrigin` (server-side config only). `data` is optional so the page still
  // renders — with plain-text guidance — when no load data is supplied.
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
<HandoffConfirmContent {centralizeMeOrigin}>
  <InjectionPoint name="auth.handoff.content" data={data?.__inject} />
</HandoffConfirmContent>
<InjectionPoint name="auth.handoff.after" data={data?.__inject} />

<svelte:head>
  <title>{m.auth_handoff_page_title()}</title>
</svelte:head>
