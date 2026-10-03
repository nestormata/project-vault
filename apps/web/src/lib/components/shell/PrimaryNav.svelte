<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import type { ResolvedExtensionNavItem } from '$lib/api/extension-panel.js'
  import { renderSurface } from '$lib/navigation/build-surface.js'
  import type { NavNode, NavUser } from '$lib/navigation/types.js'
  import { buildExtensionNavTopLevelItems, isActiveNavItem } from './nav-model.js'

  let {
    onsearch,
    isPlatformOperator = false,
    hasUiPanelExtension = false,
    extensionNavItems = [],
    user,
  }: {
    onsearch?: () => void
    isPlatformOperator?: boolean
    hasUiPanelExtension?: boolean
    extensionNavItems?: ResolvedExtensionNavItem[]
    /** Story 68.7: the signed-in user, for nav conditions (`when`) that read the org role. */
    user?: NavUser
  } = $props()

  // Story 28.4 AC2 / Story 68.7 AC-4: one $derived over the props, so the labels re-resolve on every
  // reactive update, including right after a setLocale(..., { reload: false }) elsewhere in the app
  // (SvelteKit's update() hands this component fresh prop values such as a new `extensionNavItems`
  // array). Story 68.7: PV's (and a composed app's) items come from the `primary` surface's data
  // with the active nav delta applied; the frozen Story 29.3 `navItems` are appended after them,
  // exactly as before, and are not part of the delta.
  /** What main rendered between PV's search button and the first link (two whitespace nodes). */
  const ACTION_GAP = '  '

  const nav = $derived({
    nodes: renderSurface('primary', {
      pathname: page.url.pathname,
      user: { isPlatformOperator, orgRole: user?.orgRole ?? '' },
      hasUiPanelExtension,
      search: () => onsearch?.(),
    }),
    legacy: buildExtensionNavTopLevelItems(extensionNavItems),
  })

  /**
   * Story 29.3 AC6/AC12 — the host-owned icon-token-to-glyph map. An icon token with no matching
   * entry here (should be unreachable given AC6's load-time validation, but the render layer must
   * not assume that invariant holds forever) renders no icon rather than throwing — see the
   * `{#if}` guard below, which simply omits the icon element for an unrecognized token.
   */
  const NAV_ICON_GLYPHS: Record<string, string> = {
    'puzzle-piece': '🧩',
    link: '🔗',
    grid: '▦',
  }
</script>

<nav
  aria-label="Primary navigation"
  data-testid="primary-nav"
  class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3"
>
  {#snippet nodeLabel(node: NavNode)}
    {#if node.icon}<node.icon />{/if}
    <span class="hidden sm:inline">{node.label}</span>
    <span class="sm:hidden">{node.mobileLabel}</span>
  {/snippet}
  <!--
    Story 68.7 AC-3: one renderer for every depth. A node with children is a native
    <details>/<summary> disclosure (keyboard: Tab focuses, Enter/Space toggles); its <summary> is
    marked active while any descendant is. A node with both an href and children lists its own link
    first inside the disclosure. Nested entries render like the legacy children below.
  -->
  {#snippet navNode(node: NavNode, nested: boolean)}
    {#if node.children.length > 0}
      <details class="relative">
        <summary
          class={`flex cursor-pointer list-none items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium ${node.current ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
        >
          {@render nodeLabel(node)}
        </summary>
        <div
          class="flex flex-col gap-1 py-1 md:absolute md:z-10 md:min-w-40 md:rounded-xl md:border md:border-slate-200 md:bg-white md:p-1 md:shadow-lg"
        >
          {#if node.href !== undefined || node.external !== undefined}
            {@render navLeaf({ ...node, children: [] }, true)}
          {/if}
          {#each node.children as child (child.id)}
            {@render navNode(child, true)}
          {/each}
        </div>
      </details>
    {:else}
      {@render navLeaf(node, nested)}
    {/if}
  {/snippet}
  <!--
    An action: an icon-only action keeps its label as screen-reader text (its accessible name). A
    top-level action is followed by the same two-space separator main's markup had after PV's search
    button (AppShell's characterization test compares it byte for byte).
  -->
  {#snippet actionContent(node: NavNode)}
    {#if node.icon}<node.icon />{/if}
    <span class={node.icon ? 'sr-only' : undefined}>{node.label}</span>
    {#if node.shortcut}<kbd
        class="hidden rounded border border-slate-300 px-1 text-xs sm:inline"
        aria-hidden="true">{node.shortcut}</kbd
      >{/if}
  {/snippet}
  {#snippet navLeaf(node: NavNode, nested: boolean)}
    {#if node.onSelect !== undefined && node.href === undefined && node.external === undefined}
      {#if nested}
        <button
          class="rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-100"
          type="button"
          title={node.title || undefined}
          onclick={() => node.onSelect?.()}
        >
          {@render actionContent(node)}
        </button>
      {:else}
        <button
          class="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800"
          type="button"
          aria-label={node.title || undefined}
          title={node.title || undefined}
          onclick={() => node.onSelect?.()}
        >
          {@render actionContent(node)}
        </button>{ACTION_GAP}
      {/if}
    {:else if node.external !== undefined}
      <a
        href={`${node.external.scheme}://${node.external.rest}`}
        target="_blank"
        rel="noopener noreferrer"
        class={nested
          ? 'rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100'
          : 'flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100'}
      >
        {@render nodeLabel(node)}
      </a>
    {:else if nested}
      <a
        class={`rounded-lg px-3 py-2 text-sm font-medium ${node.active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
        aria-current={node.active ? 'page' : undefined}
        href={node.href}
      >
        {#if node.icon}<node.icon />{/if}
        {node.label}
      </a>
    {:else}
      <a
        class={`flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium ${node.active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
        aria-current={node.active ? 'page' : undefined}
        href={node.href}
      >
        {@render nodeLabel(node)}
      </a>
    {/if}
  {/snippet}
  <!--
    Story 29.3 AC10/AC12 bug fix (found via Chrome-driven manual verification, 2026-08-29): keyed
    by array index, not `item.href`. AC10 does not forbid a manifest-declared `navItems` entry's
    `href` from matching one of PV's own hardcoded nav routes (a real, plausible case — an
    extension linking to a page PV already has a nav entry for), so `item.href` is not a reliably
    unique key across the merged array. A colliding href previously threw Svelte's
    `each_key_duplicate` in a real browser (jsdom's own test render path never exercised this,
    since every unit test's fixture hrefs were deliberately non-colliding), breaking primary-nav
    rendering entirely. `navItems` is rebuilt fresh, in a stable order, on every render (no
    reordering/dragging), so an index key loses no real reconciliation behavior here.
  -->
  <!--
    Extracted (code-review fix, 2026-08-29): the icon+label markup was duplicated verbatim between
    the <summary> branch (a parent item) and the <a> branch (a leaf item) below — jscpd flagged the
    clone. A snippet keeps both branches rendering identical icon/label markup from one definition.
  -->
  {#snippet itemLabel(item: { icon?: string; label: string; mobileLabel: string })}
    {#if item.icon && NAV_ICON_GLYPHS[item.icon]}
      <span data-nav-icon={item.icon} aria-hidden="true">{NAV_ICON_GLYPHS[item.icon]}</span>
    {/if}
    <span class="hidden sm:inline">{item.label}</span>
    <span class="sm:hidden">{item.mobileLabel}</span>
  {/snippet}
  <!-- PV's and a composed app's items (keyed by id), then the frozen legacy tail (index keys). -->
  {#each nav.nodes as node (node.id)}
    {@render navNode(node, false)}
  {/each}{#each nav.legacy as item, itemIndex (itemIndex)}
    {@const active = isActiveNavItem(item.href, page.url.pathname)}
    {#if item.children && item.children.length > 0}
      <!--
        Story 29.3 AC12 — a native <details>/<summary> disclosure for a parent item's children:
        keyboard/screen-reader accessibility comes from the browser's own semantics (Tab to focus,
        Enter/Space to toggle) rather than new custom JS/ARIA wiring.
      -->
      <details class="relative">
        <summary
          class={`flex cursor-pointer list-none items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium ${active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
        >
          {@render itemLabel(item)}
        </summary>
        <div
          class="flex flex-col gap-1 py-1 md:absolute md:z-10 md:min-w-40 md:rounded-xl md:border md:border-slate-200 md:bg-white md:p-1 md:shadow-lg"
        >
          <!--
            Code-review fix (2026-08-29): keyed by array index, for the same reason as the
            top-level {#each} above. validateNavItemsShape() only enforces `id` uniqueness across
            a manifest's navItems, not `href` uniqueness — two children declared under the same
            parent (or a child sharing an href with a sibling) can legally share an `href`, which
            would reintroduce the exact each_key_duplicate production crash the top-level fix
            addressed, one nesting level down. `item.children` is rebuilt fresh, in a stable
            order, on every render, so an index key loses no real reconciliation behavior here.
          -->
          {#each item.children as child, childIndex (childIndex)}
            {@const childActive = isActiveNavItem(child.href, page.url.pathname)}
            {@const childHref = resolve(
              // @ts-expect-error -- extension navItems hrefs are runtime strings validated by NAV_ITEM_HREF_PATTERN, not members of the generated Pathname union; signed off by Nestor 2026-09-30 (story 68-1, AGENTS.md quality-gate exception), remove with 68-7
              child.href
            )}
            <a
              class={`rounded-lg px-3 py-2 text-sm font-medium ${childActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              aria-current={childActive ? 'page' : undefined}
              href={childHref}
            >
              {child.label}
            </a>
          {/each}
        </div>
      </details>
    {:else}
      {@const itemHref = resolve(
        // @ts-expect-error -- extension navItems hrefs are runtime strings validated by NAV_ITEM_HREF_PATTERN, not members of the generated Pathname union; signed off by Nestor 2026-09-30 (story 68-1, AGENTS.md quality-gate exception), remove with 68-7
        item.href
      )}
      <a
        class={`flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium ${active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
        aria-current={active ? 'page' : undefined}
        href={itemHref}
      >
        {@render itemLabel(item)}
      </a>
    {/if}
  {/each}
</nav>
