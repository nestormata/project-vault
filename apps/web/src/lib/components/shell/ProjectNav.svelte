<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { getProjectNavItems, isActiveProjectNavItem } from './project-nav-model.js'

  let {
    projectId,
    orgRole,
    isArchived = false,
  }: { projectId: string; orgRole: string; isArchived?: boolean } = $props()

  const navItems = $derived(getProjectNavItems(projectId, orgRole))
</script>

<nav
  aria-label="Project navigation"
  data-testid="project-nav"
  class="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3"
>
  {#if isArchived}
    <span
      class="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700"
      data-testid="project-nav-archived-badge"
    >
      Archived
    </span>
  {/if}
  {#each navItems as item (item.href)}
    {@const active = isActiveProjectNavItem(item, page.url.pathname)}
    <a
      class={`rounded-xl px-3 py-2 text-sm font-medium outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-950 ${active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
      aria-current={active ? 'page' : undefined}
      href={resolve(item.href)}
    >
      {item.label}
    </a>
  {/each}
</nav>
