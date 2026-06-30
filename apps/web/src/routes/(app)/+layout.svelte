<script lang="ts">
  import AppShell from '$lib/components/shell/AppShell.svelte'
  import GlobalSearch from '$lib/components/shell/GlobalSearch.svelte'
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte'
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
      oncompleted={() => {
        onboardingDone = true
      }}
    />
  {:else}
    {@render children()}
  {/if}
</AppShell>
