<script lang="ts">
  import AppShell from '$lib/components/shell/AppShell.svelte'
  import GlobalSearch from '$lib/components/shell/GlobalSearch.svelte'
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte'
  import { invalidateAll } from '$app/navigation'
  import { onMount, onDestroy } from 'svelte'
  import {
    subscribeToInboxEvents,
    setInitialUnreadCount,
    getUnreadCount,
  } from '$lib/state/notifications.svelte.js'
  import { setInitialAppliedTheme, getAppliedTheme } from '$lib/state/theme.svelte.js'
  import {
    readDismissedOrphanedTheme,
    shouldShowOrphanedNotice,
    writeDismissedOrphanedTheme,
  } from '$lib/theme/apply-theme.js'
  import type { LayoutData } from './$types'

  const { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props()

  let onboardingDone = $state(data.onboardingCompleted)
  let searchOpen = $state(false)
  let unsubscribeInbox: (() => void) | null = null

  $effect(() => {
    setInitialUnreadCount(data.unreadCount ?? 0)
  })

  // Story 16.2 AC-2/AC-6: seeds the shared, app-wide theme rune from this load's fresh-from-DB
  // resolution. `(app)/settings/themes/` updates this same rune directly (pessimistically, after
  // a successful PATCH) so every already-mounted part of the app re-renders immediately, with no
  // navigation and no full-page reload.
  $effect(() => {
    setInitialAppliedTheme(data.appliedTheme ?? null)
  })

  // Story 16.2 AC-3: the one-time dismissible orphaned-theme notice. Re-evaluated whenever the
  // server-resolved orphan state changes (e.g. a fresh navigation after an admin's reload) against
  // the sessionStorage dismissal key for that *specific* orphaned theme name — see
  // `$lib/theme/apply-theme.ts`'s `shouldShowOrphanedNotice` for the exact re-show/suppress rules.
  let orphanedNoticeVisible = $state(false)
  $effect(() => {
    if (data.orphanedNotice && data.orphanedThemeName) {
      const dismissed =
        typeof sessionStorage === 'undefined' ? null : readDismissedOrphanedTheme(sessionStorage)
      orphanedNoticeVisible = shouldShowOrphanedNotice(data.orphanedThemeName, dismissed)
    } else {
      orphanedNoticeVisible = false
    }
  })

  function dismissOrphanedNotice() {
    if (data.orphanedThemeName && typeof sessionStorage !== 'undefined') {
      writeDismissedOrphanedTheme(sessionStorage, data.orphanedThemeName)
    }
    orphanedNoticeVisible = false
  }

  onMount(() => {
    unsubscribeInbox = subscribeToInboxEvents()
  })

  onDestroy(() => {
    unsubscribeInbox?.()
  })

  const unreadCount = $derived(getUnreadCount())
  const appliedTheme = $derived(getAppliedTheme())
</script>

<GlobalSearch bind:open={searchOpen} />

{#if data.themeCss}
  <!--
    Story 16.2 AC-2: delivers 16.1's already CSS-injection-hardened compiled `[data-theme]` blocks
    as a real inline stylesheet element — `<svelte:element>` (a genuine runtime DOM element, never
    Svelte's own specially-compiled static `<style>` block) with its normal, auto-escaped text-node
    child, NEVER the `@html` directive (this repo's static-hardening gate forbids that entirely, see
    apps/web/src/lib/security/static-hardening.test.ts). Rendered directly in the initial SSR'd
    HTML (no onMount/client-only injection) so the very first page load already carries every
    compiled theme's CSS — the AC-2 "no FOUC" requirement — with the `data-theme` attribute below
    then simply toggling which block applies, live, no re-fetch needed.
  -->
  <svelte:element this={"style"}>{data.themeCss}</svelte:element>
{/if}

<div data-theme={appliedTheme ?? undefined}>
  {#if orphanedNoticeVisible}
    <div
      role="alert"
      class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-800"
    >
      Your selected theme is no longer available — showing the default.
      <button
        type="button"
        class="ml-2 underline hover:no-underline"
        onclick={dismissOrphanedNotice}
      >
        Dismiss
      </button>
    </div>
  {/if}

  <AppShell
    user={data.user}
    hidePrimaryNav={!onboardingDone}
    {unreadCount}
    hasUiPanelExtension={data.hasUiPanelExtension}
    onsearch={() => {
      searchOpen = true
    }}
  >
    {#if !onboardingDone}
      <OnboardingWizard
        user={data.user}
        projects={data.projects}
        importRouteLive={data.importRouteLive}
        oncompleted={async () => {
          // AC-1/2/3: the dashboard's +page.server.ts load already ran (in parallel, as part of
          // the initial navigation to /dashboard) before the wizard's mutations landed, so its
          // `data` is stale by the time `children()` first mounts. `invalidateAll()` re-runs every
          // load function for the current route (this layout's and the page's) with the wizard's
          // writes now durably committed, so `children()` only ever mounts with fresh data — no
          // client-side polling loop or artificial delay, and no window where a partial/failed
          // mutation could still flip this to true (the wizard itself only calls `oncompleted`
          // after its own mutation promise has settled — see
          // OnboardingWizard.svelte/onboarding-logic.ts).
          await invalidateAll()
          onboardingDone = true
        }}
      />
    {:else}
      {@render children()}
    {/if}
  </AppShell>
</div>
