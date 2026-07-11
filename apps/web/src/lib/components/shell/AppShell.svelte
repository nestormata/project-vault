<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { logout } from '$lib/api/auth.js'
  import Footer from './Footer.svelte'
  import PrimaryNav from './PrimaryNav.svelte'

  let {
    user,
    children,
    hidePrimaryNav = false,
    unreadCount = 0,
    onsearch,
  }: {
    user: import('$lib/api/auth.js').AuthUser
    children: import('svelte').Snippet
    hidePrimaryNav?: boolean
    unreadCount?: number
    onsearch?: () => void
  } = $props()
  let logoutError = $state(null)

  async function signOut() {
    logoutError = null
    try {
      await logout(fetch)
    } catch {
      // A missing/expired session should not trap the user in the app shell.
    }
    await goto(resolve('/login?reason=logged-out'))
  }
</script>

<div class="min-h-screen bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div
      class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between"
    >
      <div>
        <div class="flex items-center gap-2">
          <img src={resolve('/logo-mark.png')} alt="" width="276" height="240" class="h-8 w-auto" />
          {#if hidePrimaryNav}
            <p class="text-xl font-bold text-brand-600">Project Vault</p>
          {:else}
            <a class="text-xl font-bold text-brand-600" href={resolve('/dashboard')}
              >Project Vault</a
            >
          {/if}
        </div>
        <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div>
      {#if !hidePrimaryNav}
        <PrimaryNav {onsearch} isPlatformOperator={user.isPlatformOperator} />
      {/if}
      <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
        {#if !hidePrimaryNav}
          <a
            href={resolve('/notifications')}
            class="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Notifications"
          >
            <svg
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            {#if unreadCount > 0}
              <span
                class="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-xs font-medium text-white"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            {/if}
          </a>
        {/if}
        <span>Role: {user.orgRole}</span>
        <span class="max-w-full break-all">Org: {user.orgName}</span>
        <button
          class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800"
          type="button"
          onclick={signOut}
        >
          Sign out
        </button>
      </div>
    </div>
    {#if user.mfaStatus.enrollmentRequired || user.mfaStatus.bannerMessage}
      <div class="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        {user.mfaStatus.bannerMessage}
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
