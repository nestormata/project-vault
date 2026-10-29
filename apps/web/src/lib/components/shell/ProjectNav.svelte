<script lang="ts">
  import { page } from '$app/state'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ArchivedBadge from '$lib/components/projects/ArchivedBadge.svelte'
  import NavEntry from '$lib/navigation/NavEntry.svelte'
  import { renderSurface } from '$lib/navigation/build-surface.js'
  import type { NavNode } from '$lib/navigation/types.js'
  import type { ProjectOverview } from '@project-vault/shared'
  import MoreMenu from './MoreMenu.svelte'
  import { TAB_OVERFLOW_BELOW_PX, TABS_INLINE_WHEN_NARROW } from './shell-variant.js'

  // Story 69.1: `project` and `data` feed the `project.layout.nav` region point at the end of the
  // `<nav>` (the layout passes its own `__inject` map; a caller that passes neither renders none).
  let {
    projectId,
    orgRole,
    isArchived = false,
    project = null,
    data,
  }: {
    projectId: string
    orgRole: string
    isArchived?: boolean
    project?: ProjectOverview | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 68.7 AC-4: the tabs come from the `project` surface's data (the active nav delta
  // applied), evaluated per render. `page.data` is read so this re-derives after SvelteKit's
  // update() (which replaces it) following a no-reload locale switch: the label message functions
  // read no Svelte signal themselves (the Story 28.4 hazard).
  const navNodes = $derived.by(() => {
    void page.data
    return renderSurface('project', { projectId, orgRole, pathname: page.url.pathname })
  })

  // Story 72.7 (P3b): below 900 px the tabs past the first few collapse into a "More" menu. The
  // server (and a browser without script) renders every tab, wrapping onto lines as before; the
  // collapse is applied after mount from the viewport width, so it never changes the SSR markup.
  let narrow = $state(false)
  $effect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(`(max-width: ${TAB_OVERFLOW_BELOW_PX - 0.02}px)`)
    const sync = () => (narrow = query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  })
  const inlineNodes = $derived(narrow ? navNodes.slice(0, TABS_INLINE_WHEN_NARROW) : navNodes)
  const overflowNodes = $derived(narrow ? navNodes.slice(TABS_INLINE_WHEN_NARROW) : [])

  const tabClass = (active: boolean) =>
    `rounded-xl px-3 py-2 text-sm font-medium outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-950 ${active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`
</script>

<!--
  Story 68.7 AC-3: a tab with children is a disclosure tab (native <details>/<summary>) whose panel
  lists them, at any depth; its summary is marked active while any descendant is.
-->
{#snippet tab(node: NavNode, inMore: boolean = false)}
  {#if node.children.length > 0}
    <details class="relative">
      <summary class={`cursor-pointer list-none ${tabClass(node.current)}`}>{node.label}</summary>
      <div
        class={inMore
          ? 'flex flex-col gap-1 py-1 pl-3'
          : 'flex flex-col gap-1 py-1 md:absolute md:z-10 md:min-w-40 md:rounded-xl md:border md:border-slate-200 md:bg-white md:p-1 md:shadow-lg'}
      >
        {#if node.href !== undefined || node.external !== undefined}
          {@render tab({ ...node, children: [] }, inMore)}
        {/if}
        {#each node.children as child (child.id)}
          {@render tab(child, inMore)}
        {/each}
      </div>
    </details>
  {:else if node.href !== undefined && node.external === undefined}
    <a
      class={tabClass(node.active)}
      aria-current={node.active ? 'page' : undefined}
      href={node.href}
    >
      {node.label}
    </a>
  {:else}
    <NavEntry {node} class={tabClass(false)} />
  {/if}
{/snippet}

<!-- @region project.layout.nav -->
<nav
  aria-label="Project navigation"
  data-testid="project-nav"
  class="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3"
>
  {#if isArchived}
    <ArchivedBadge testid="project-nav-archived-badge" />
  {/if}
  {#each inlineNodes as node (node.id)}
    {@render tab(node)}
  {/each}{#if overflowNodes.length > 0}<MoreMenu
      summaryClass={tabClass(overflowNodes.some((node) => node.current))}
      current={overflowNodes.some((node) => node.current)}
      testid="project-nav-more"
    >
      {#each overflowNodes as node (node.id)}
        {@render tab(node, true)}
      {/each}
    </MoreMenu>{/if}<InjectionPoint name="project.layout.nav" props={{ project }} {data} />
</nav>
