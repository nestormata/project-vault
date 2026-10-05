<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type { Snippet } from 'svelte'
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte'
  import AppShell from '$lib/components/shell/AppShell.svelte'

  let {
    appliedTheme,
    orphanedNoticeVisible,
    dismissOrphanedNotice,
    user,
    onboardingDone,
    unreadCount,
    hasUiPanelExtension,
    extensionNavItems,
    injected,
    openSearch,
    projects,
    importRouteLive,
    completeOnboarding,
    body,
    children,
  }: {
    appliedTheme: string | null
    orphanedNoticeVisible: boolean
    dismissOrphanedNotice: () => void
    user: ComponentProps<typeof AppShell>['user']
    onboardingDone: boolean
    unreadCount: number
    hasUiPanelExtension: boolean
    extensionNavItems: ComponentProps<typeof AppShell>['extensionNavItems']
    injected: ComponentProps<typeof AppShell>['injected']
    openSearch: () => void
    projects: ComponentProps<typeof OnboardingWizard>['projects']
    importRouteLive: boolean
    completeOnboarding: () => Promise<void>
    body: Snippet
    children?: Snippet
  } = $props()
</script>

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
    {user}
    hidePrimaryNav={!onboardingDone}
    {unreadCount}
    {hasUiPanelExtension}
    {extensionNavItems}
    {injected}
    onsearch={openSearch}
  >
    {#if !onboardingDone}
      <OnboardingWizard {user} {projects} {importRouteLive} oncompleted={completeOnboarding} />
    {:else}
      {@render body()}
    {/if}
  </AppShell>
</div>
{@render children?.()}
