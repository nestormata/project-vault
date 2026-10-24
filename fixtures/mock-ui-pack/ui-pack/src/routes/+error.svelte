<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RootErrorContent from '$lib/components/public/RootErrorContent.svelte'
  import RootErrorHeader from '$lib/components/public/RootErrorHeader.svelte'
  import { renderSurface, withDescendants } from '$lib/navigation/build-surface.js'
  import { page } from '$app/state'

  const isNotFound = $derived(page.status === 404)
  const authenticated = $derived(
    ((page.data as { user?: unknown } | undefined)?.user ?? null) !== null
  )
  const backLinks = $derived(
    renderSurface('error.nav', { pathname: '', authenticated }).flatMap(withDescendants)
  )
  const heading = $derived(isNotFound ? 'Page not found' : 'Something went wrong')
</script>

<!-- Story 69.13: the pack page also renders PV's own error regions, so the `root.error.*` points
  (render-only: an error page has no load) are proven end to end in a product that overrides it. -->
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
  <RootErrorContent
    {isNotFound}
    status={page.status}
    {heading}
    description="mock-ui-pack:m1-error-description"
    {backLinks}
  >
    <InjectionPoint name="root.error.content" data={page.data?.__inject} />
  </RootErrorContent>
</div>
<InjectionPoint name="root.error.after" data={page.data?.__inject} />

<!-- M1 (d): a root error page. It prints SvelteKit's sanitised message, never a stack. -->
<div data-testid="mock-error">
  <h1>mock-ui-pack:m1-error</h1>
  <p data-testid="mock-error-status">{page.status}</p>
  <p data-testid="mock-error-message">{page.error?.message ?? ''}</p>
</div>
