<script lang="ts">
  import { goto } from '$app/navigation'
  import { logout } from '$lib/api/auth.js'
  import PrimaryNav from './PrimaryNav.svelte'

  let { user, children } = $props()
  let logoutError = $state(null)

  async function signOut() {
    logoutError = null
    try {
      await logout(fetch)
    } catch {
      // A missing/expired session should not trap the user in the app shell.
    }
    await goto('/login?reason=logged-out')
  }
</script>

<div class="min-h-screen bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div
      class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between"
    >
      <div>
        <a class="text-xl font-bold" href="/dashboard">Project Vault</a>
        <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div>
      <PrimaryNav />
      <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
        <span>Role: {user.orgRole}</span>
        <span class="max-w-full break-all">Org: {user.orgId}</span>
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
  <main class="mx-auto max-w-7xl px-4 py-6">
    {@render children()}
  </main>
</div>
