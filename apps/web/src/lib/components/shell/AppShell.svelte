<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ResolvedExtensionNavItem } from '$lib/api/extension-panel.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import Footer from './Footer.svelte'
  import NotificationsLink from './NotificationsLink.svelte'
  import PrimaryNav from './PrimaryNav.svelte'
  import ShellAccount from './ShellAccount.svelte'
  import ShellBrand from './ShellBrand.svelte'

  let {
    user,
    children,
    hidePrimaryNav = false,
    unreadCount = 0,
    onsearch,
    hasUiPanelExtension = false,
    extensionNavItems = [],
    injected,
  }: {
    user: import('$lib/api/auth.js').AuthUser
    children: import('svelte').Snippet
    hidePrimaryNav?: boolean
    unreadCount?: number
    onsearch?: () => void
    hasUiPanelExtension?: boolean
    extensionNavItems?: ResolvedExtensionNavItem[]
    /** The `(app)` layout's `data.__inject`, for the `shell.header.end` point. */
    injected?: App.PageData['__inject']
  } = $props()
  let logoutError = $state(null)
  const MFA_SETTINGS_PATH = '/settings/security'
</script>

<div class="min-h-screen bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div
      class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between"
    >
      <ShellBrand {hidePrimaryNav} />
      {#if !hidePrimaryNav}
        <PrimaryNav
          {onsearch}
          isPlatformOperator={user.isPlatformOperator}
          {hasUiPanelExtension}
          {extensionNavItems}
        />
      {/if}
      <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
        {#if !hidePrimaryNav}
          <NotificationsLink {unreadCount} />
        {/if}
        <ShellAccount {user} /><InjectionPoint name="shell.header.end" data={injected} />
      </div>
    </div>
    {#if user.mfaStatus.enrollmentRequired || user.mfaStatus.bannerMessage}
      <div class="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        {#if user.mfaStatus.bannerMessage && user.mfaStatus.bannerMessage.includes(MFA_SETTINGS_PATH)}
          {user.mfaStatus.bannerMessage.slice(
            0,
            user.mfaStatus.bannerMessage.indexOf(MFA_SETTINGS_PATH)
          )}<a class="font-medium underline" href={resolve(MFA_SETTINGS_PATH)}
            >{MFA_SETTINGS_PATH}</a
          >{user.mfaStatus.bannerMessage.slice(
            user.mfaStatus.bannerMessage.indexOf(MFA_SETTINGS_PATH) + MFA_SETTINGS_PATH.length
          )}
        {:else}
          {user.mfaStatus.bannerMessage}
        {/if}
      </div>
    {/if}
    {#if logoutError}
      <p class="px-4 py-2 text-sm text-red-700" role="alert">{logoutError}</p>
    {/if}
  </header>
  <main class={hidePrimaryNav ? 'p-0' : 'mx-auto max-w-7xl px-4 py-6'}>
    {@render children()}
  </main>
  <div class="border-t border-slate-200">
    <Footer />
  </div>
</div>
