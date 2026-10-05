<script lang="ts">
  import RootErrorHeader from '$lib/components/public/RootErrorHeader.svelte'
  import RootErrorContent from '$lib/components/public/RootErrorContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { page } from '$app/state'

  import { renderSurface, withDescendants } from '$lib/navigation/build-surface.js'

  // AC-19: distinguish a genuine thrown error (5xx, or any non-404 status) from a bare unmatched
  // route (404) — the copy must not claim "Page not found" for the former.
  const isNotFound = $derived(page.status === 404)

  // AC-18: an unmatched route means no ancestor layout `load` ran, so there's no reliable way to
  // read auth state here in the general case. Where an ancestor layout DID run successfully
  // before throwing (e.g. a genuine 500 from inside an authenticated route already past
  // `(app)/+layout.server.ts`), `page.data.user` is available and we link straight to
  // /dashboard; otherwise we fall back to `/`, which itself redirects to /login or /dashboard
  // based on actual auth state (confirmed via src/routes/root-page.server.test.ts) — an
  // acceptable equivalent per this story's AC-18 when distinguishing auth state directly in
  // +error.svelte isn't practical.
  const authenticatedUser = $derived(
    (page.data as { user?: { userId: string } } | undefined)?.user ?? null
  )
  // Story 68.7 (S15): the way back is the `error.nav` surface's data (Dashboard when signed in).
  // It marks no current item, so it needs no path.
  const backLinks = $derived(
    renderSurface('error.nav', {
      pathname: '',
      authenticated: authenticatedUser !== null,
    }).flatMap(withDescendants)
  )

  const heading = $derived(isNotFound ? 'Page not found' : 'Something went wrong')
  const description = $derived(
    isNotFound
      ? "The page you're looking for doesn't exist or may have moved."
      : "An unexpected error occurred while loading this page. It's not you — try again in a moment."
  )
</script>

<svelte:head>
  <title>{heading} | Project Vault</title>
</svelte:head>

<InjectionPoint name="root.error.before" data={page.data?.__inject} />
<InjectionPoint name="root.error.header.actions" data={page.data?.__inject} />
<div class="min-h-screen bg-slate-50 text-slate-950">
  <!-- @region root.error.header -->
  <RootErrorHeader>
    <InjectionPoint name="root.error.header" data={page.data?.__inject} />
  </RootErrorHeader>

  <!-- @region root.error.content -->
  <RootErrorContent {isNotFound} status={page.status} {heading} {description} {backLinks}>
    <InjectionPoint name="root.error.content" data={page.data?.__inject} />
  </RootErrorContent>
</div>
<InjectionPoint name="root.error.after" data={page.data?.__inject} />
