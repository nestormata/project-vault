<script lang="ts">
  import AuthLayoutThemeStyle from '$lib/components/auth/AuthLayoutThemeStyle.svelte'
  import AuthLayoutBody from '$lib/components/auth/AuthLayoutBody.svelte'
  import AuthLayoutFooter from '$lib/components/auth/AuthLayoutFooter.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { onMount } from 'svelte'
  import AuthBrandHeader from '$lib/components/shell/AuthBrandHeader.svelte'

  import {
    getPreAuthThemeCss,
    getPreAuthThemeName,
    seedPreAuthThemeFromCache,
  } from '$lib/state/theme.svelte.js'

  let { children, data }: { children: import('svelte').Snippet; data?: App.PageData } = $props()

  // Story 16.4 AC-3/Task 7.2: reactively picks up whatever LoginForm's domain-lookup call last
  // resolved (or clears back to base on a miss/fail-open path) — no server load exists for this
  // layout to seed an initial value from, unlike the `(app)` layout's SSR-resolved `appliedTheme`.
  const preAuthThemeName = $derived(getPreAuthThemeName())
  const preAuthThemeCss = $derived(getPreAuthThemeCss())

  // Story 16.6 AC-2/AC-9 Task 3.1: seed optimistically from the cache once per full navigation
  // into this layout, before any page-level domain-lookup would otherwise fire. No-op if a
  // page-level resolution already completed (race guard lives in seedPreAuthThemeFromCache).
  onMount(() => {
    seedPreAuthThemeFromCache()
  })
</script>

<!-- @region auth.layout.theme -->
<AuthLayoutThemeStyle {preAuthThemeCss}>
  <InjectionPoint name="auth.layout.theme" data={data?.__inject} />
</AuthLayoutThemeStyle>

<main
  class="min-h-screen bg-slate-50 px-4 py-10 text-slate-950"
  data-theme={preAuthThemeName ?? undefined}
>
  <section class="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <AuthBrandHeader />
    <InjectionPoint name="auth.layout.before" data={data?.__inject} />
    <InjectionPoint name="auth.layout.header.actions" data={data?.__inject} />
    <!-- @region auth.layout.body -->
    <AuthLayoutBody body={children}>
      <InjectionPoint name="auth.layout.body" data={data?.__inject} />
    </AuthLayoutBody><InjectionPoint name="auth.layout.after" data={data?.__inject} />
  </section>
  <!-- @region auth.layout.footer -->
  <AuthLayoutFooter>
    <InjectionPoint name="auth.layout.footer" data={data?.__inject} />
  </AuthLayoutFooter>
</main>
