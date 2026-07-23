<script lang="ts">
  import { page } from '$app/state'
  import { resolve } from '$app/paths'

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
  const backPath = $derived(authenticatedUser ? ('/dashboard' as const) : ('/' as const))
  const backLabel = $derived(authenticatedUser ? 'Back to Dashboard' : 'Back to Project Vault')

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

<div class="min-h-screen bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div class="mx-auto max-w-7xl px-4 py-4">
      <p class="text-xl font-bold text-brand-600">Project Vault</p>
    </div>
  </header>

  <main class="mx-auto max-w-2xl px-4 py-16 text-center">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
      {isNotFound ? '404' : `Error ${page.status}`}
    </p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">{heading}</h1>
    <p class="mt-4 text-slate-600">{description}</p>

    <nav aria-label="Error page navigation" class="mt-8">
      <a
        class="inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white"
        href={resolve(backPath)}
      >
        {backLabel}
      </a>
    </nav>
  </main>
</div>
