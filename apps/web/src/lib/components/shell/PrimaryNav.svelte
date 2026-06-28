<script lang="ts">
  import { page } from '$app/state'
  import { getPrimaryNavItems, isActiveNavItem } from './nav-model.js'

  const navItems = getPrimaryNavItems()
</script>

<nav aria-label="Primary navigation" class="flex flex-col gap-2 md:flex-row md:items-center">
  {#each navItems as item}
    {@const active = isActiveNavItem(item.href, page.url.pathname)}
    <a
      class={`rounded-xl px-3 py-2 text-sm font-medium ${active ? 'bg-slate-950 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
      aria-current={active ? 'page' : undefined}
      href={item.href}
    >
      <span class="hidden sm:inline">{item.label}</span>
      <span class="sm:hidden">{item.mobileLabel}</span>
    </a>
  {/each}
</nav>
