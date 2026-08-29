<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import type { ResolvedExtensionNavItem } from '$lib/api/extension-panel.js'
  import { getPrimaryNavItems, isActiveNavItem } from './nav-model.js'

  let {
    onsearch,
    isPlatformOperator = false,
    hasUiPanelExtension = false,
    extensionNavItems = [],
  }: {
    onsearch?: () => void
    isPlatformOperator?: boolean
    hasUiPanelExtension?: boolean
    extensionNavItems?: ResolvedExtensionNavItem[]
  } = $props()

  // Story 28.4 AC2: $derived (not a plain const) so navItems re-reads the current locale on every
  // reactive update, including immediately after a setLocale(..., { reload: false }) call
  // elsewhere in the app — a plain const would only ever resolve getPrimaryNavItems() once, at
  // whatever locale was active when this component first mounted.
  const navItems = $derived(
    getPrimaryNavItems({ isPlatformOperator, hasUiPanelExtension, extensionNavItems })
  )

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
  {#each navItems as item, itemIndex (itemIndex)}
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
            <a
              class={`rounded-lg px-3 py-2 text-sm font-medium ${childActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              aria-current={childActive ? 'page' : undefined}
              href={resolve(child.href)}
            >
              {child.label}
            </a>
          {/each}
        </div>
      </details>
    {:else}
      <a
        class={`flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium ${active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
        aria-current={active ? 'page' : undefined}
        href={resolve(item.href)}
      >
        {@render itemLabel(item)}
      </a>
    {/if}
  {/each}
</nav>
