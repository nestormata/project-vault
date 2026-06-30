<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { getPrimaryNavItems, isActiveNavItem } from './nav-model.js'

  let { onsearch }: { onsearch?: () => void } = $props()

  const navItems = getPrimaryNavItems()
</script>

<nav
  aria-label="Primary navigation"
  data-testid="primary-nav"
  class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3"
>
  <button
    class="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800"
    type="button"
    aria-label="Search (⌘K)"
    title="Search (⌘K)"
    onclick={() => onsearch?.()}
  >
    <span aria-hidden="true">⌕</span>
    <span class="sr-only">Search</span>
    <kbd class="hidden rounded border border-slate-300 px-1 text-xs sm:inline" aria-hidden="true"
      >⌘K</kbd
    >
  </button>
  {#each navItems as item (item.href)}
    {@const active = isActiveNavItem(item.href, page.url.pathname)}
    <a
      class={`rounded-xl px-3 py-2 text-sm font-medium ${active ? 'bg-slate-950 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
      aria-current={active ? 'page' : undefined}
      href={resolve(item.href)}
    >
      <span class="hidden sm:inline">{item.label}</span>
      <span class="sm:hidden">{item.mobileLabel}</span>
    </a>
  {/each}
</nav>
