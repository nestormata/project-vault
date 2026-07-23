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
  import type { LayoutData } from './$types'

  const { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props()

  let onboardingDone = $state(data.onboardingCompleted)
  let searchOpen = $state(false)
  let unsubscribeInbox: (() => void) | null = null

  $effect(() => {
    setInitialUnreadCount(data.unreadCount ?? 0)
  })

  onMount(() => {
    unsubscribeInbox = subscribeToInboxEvents()
  })

  onDestroy(() => {
    unsubscribeInbox?.()
  })

  const unreadCount = $derived(getUnreadCount())
</script>

<GlobalSearch bind:open={searchOpen} />

<AppShell
  user={data.user}
  hidePrimaryNav={!onboardingDone}
  {unreadCount}
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
        // AC-1/2/3: the dashboard's +page.server.ts load already ran (in parallel, as part of the
        // initial navigation to /dashboard) before the wizard's mutations landed, so its `data`
        // is stale by the time `children()` first mounts. `invalidateAll()` re-runs every load
        // function for the current route (this layout's and the page's) with the wizard's writes
        // now durably committed, so `children()` only ever mounts with fresh data — no client-side
        // polling loop or artificial delay, and no window where a partial/failed mutation could
        // still flip this to true (the wizard itself only calls `oncompleted` after its own
        // mutation promise has settled — see OnboardingWizard.svelte/onboarding-logic.ts).
        await invalidateAll()
        onboardingDone = true
      }}
    />
  {:else}
    {@render children()}
  {/if}
</AppShell>
