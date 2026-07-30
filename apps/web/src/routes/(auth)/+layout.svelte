<script lang="ts">
  import { onMount } from 'svelte'
  import AuthBrandHeader from '$lib/components/shell/AuthBrandHeader.svelte'
  import Footer from '$lib/components/shell/Footer.svelte'
  import {
    getPreAuthThemeCss,
    getPreAuthThemeName,
    seedPreAuthThemeFromCache,
  } from '$lib/state/theme.svelte.js'

  let { children } = $props()

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

{#if preAuthThemeCss}
  <!--
    Story 16.4 AC-3: same delivery pattern `(app)/+layout.svelte` already uses for 16.2 —
    `<svelte:element>` with a plain auto-escaped text-node child, NEVER the html-injection
    directive (this repo's static-hardening gate forbids that directive entirely).
  -->
  <svelte:element this={"style"}>{preAuthThemeCss}</svelte:element>
{/if}

<main
  class="min-h-screen bg-slate-50 px-4 py-10 text-slate-950"
  data-theme={preAuthThemeName ?? undefined}
>
  <section class="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <AuthBrandHeader />
    {@render children()}
  </section>
  <div class="mx-auto mt-6 max-w-xl">
    <Footer />
  </div>
</main>
