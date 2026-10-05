<script lang="ts">
  import AppLayoutThemeStyle from '$lib/components/shell/AppLayoutThemeStyle.svelte'
  import AppLayoutShell from '$lib/components/shell/AppLayoutShell.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import AppLayoutSearch from '$lib/components/shell/AppLayoutSearch.svelte'

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

  // Story 68.1 AC-3: writable $derived — this layout persists across app navigations, so a later
  // load's onboardingCompleted replaces the first one, while the wizard's own completion handler
  // below can still flip it locally right after its invalidateAll().
  let onboardingDone = $derived(data.onboardingCompleted)
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

  function openSearch() {
    searchOpen = true
  }

  async function completeOnboarding() {
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

<InjectionPoint name="app.layout.before" data={data?.__inject} />
<InjectionPoint name="app.layout.header.actions" data={data?.__inject} />
<!-- @region app.layout.search -->
<AppLayoutSearch bind:open={searchOpen}>
  <InjectionPoint name="app.layout.search" data={data?.__inject} />
</AppLayoutSearch>

<!-- @region app.layout.theme -->
<AppLayoutThemeStyle themeCss={data.themeCss}>
  <InjectionPoint name="app.layout.theme" data={data?.__inject} />
</AppLayoutThemeStyle>

<!-- @region app.layout.shell -->
<AppLayoutShell
  {appliedTheme}
  {orphanedNoticeVisible}
  {dismissOrphanedNotice}
  user={data.user}
  {onboardingDone}
  {unreadCount}
  hasUiPanelExtension={data.hasUiPanelExtension}
  extensionNavItems={data.extensionNavItems}
  injected={data.__inject}
  {openSearch}
  projects={data.projects}
  importRouteLive={data.importRouteLive}
  {completeOnboarding}
  body={children}
>
  <InjectionPoint name="app.layout.shell" data={data?.__inject} />
</AppLayoutShell>
<InjectionPoint name="app.layout.after" data={data?.__inject} />
