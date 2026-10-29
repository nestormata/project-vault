<!--
  @pv-stable: the `open` bindable prop is relied on by `(app)/+layout.svelte` and by composed
  apps that replace this component (Story 68.5). Marker only; it changes no behaviour.
-->
<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { getProject } from '$lib/api/projects.js'
  import { globalSearch, type SearchResultItem } from '$lib/api/search.js'
  import { trapFocus } from '$lib/components/onboarding/focus-trap.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { daysUntil, expiresWithinDays, highlightParts } from './search-ui.js'
  import {
    asOrgRole,
    filterActions,
    projectActions,
    staticActions,
    type KnownProject,
    type PaletteAction,
    type PaletteTarget,
  } from './palette-actions.js'
  import {
    addRecent,
    checkRecent,
    readRecents,
    removeRecent,
    type RecentItem,
  } from './palette-recents.js'

  let {
    open = $bindable(false),
  }: {
    open?: boolean
  } = $props()

  let query = $state('')
  let results = $state<SearchResultItem[]>([])
  let loading = $state(false)
  let selectedIndex = $state(0)
  let dialogRef = $state<HTMLElement | null>(null)
  let inputRef = $state<HTMLInputElement | null>(null)
  let previousFocus = $state<HTMLElement | null>(null)
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let abortController: AbortController | null = null
  let cleanupFocusTrap: (() => void) | undefined

  // Story 72.5 (P12): action groups and recents. The role and user come from the layout data, so
  // the component keeps its single `open` prop (the @pv-stable contract).
  type PaletteRow =
    | { group: 'actions'; id: string; action: PaletteAction }
    | { group: 'recent'; id: string; recent: RecentItem }
    | { group: 'results'; id: string; item: SearchResultItem }

  const GROUP_LABEL = { actions: 'Actions', recent: 'Recent', results: 'Results' } as const

  let recentItems = $state<RecentItem[]>([])
  let notice = $state<string | null>(null)
  let projectInfo = $state<Record<string, KnownProject>>({})
  let generation = 0

  const orgRole = $derived(asOrgRole(page.data?.user?.orgRole))
  const userId = $derived(page.data?.user?.userId ?? null)

  const knownProjects = $derived.by(() => {
    const ids = [
      ...results.flatMap((item) => (item.type === 'project' ? [item.id] : [])),
      ...recentItems.flatMap((recent) => (recent.type === 'project' ? [recent.id] : [])),
    ]
    return ids
      .filter((id, index) => ids.indexOf(id) === index)
      .flatMap((id) => (projectInfo[id] ? [projectInfo[id]] : []))
  })

  const rows = $derived.by((): PaletteRow[] => {
    // The query filters the static actions by label; "New secret in X" is already tied to a project
    // the query (or the recents) brought in, so it is not filtered again by its own label.
    const actions = [
      ...filterActions(staticActions(orgRole), query),
      ...projectActions(orgRole, knownProjects),
    ].map((action): PaletteRow => ({ group: 'actions', id: action.id, action }))
    const rest: PaletteRow[] = query.trim()
      ? results.map((item) => ({ group: 'results', id: item.type + item.id, item }))
      : recentItems.map((recent) => ({ group: 'recent', id: recent.type + recent.id, recent }))
    return [...actions, ...rest]
  })

  function closeSearch() {
    open = false
    query = ''
    results = []
    selectedIndex = 0
    loading = false
    if (abortController) abortController.abort()
    generation += 1
    recentItems = []
    notice = null
    projectInfo = {}
    previousFocus?.focus()
  }

  function openPalette() {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    open = true
    query = ''
    results = []
    selectedIndex = 0
    notice = null
    queueMicrotask(() => inputRef?.focus())
  }

  /** Shows only recents the server still lets this user open (checked now, not remembered). */
  async function loadRecents() {
    if (!userId) return
    const mine = userId
    const current = ++generation
    const stored = readRecents(mine)
    const checks = await Promise.all(stored.map((recent) => checkRecent(fetch, recent)))
    if (current !== generation) return
    const visible: RecentItem[] = []
    const found: Record<string, KnownProject> = {}
    stored.forEach((recent, index) => {
      const check = checks[index]
      if (check?.status === 'gone') removeRecent(mine, recent)
      if (check?.status !== 'ok') return
      visible.push(recent)
      if (recent.type === 'project') {
        found[recent.id] = {
          id: recent.id,
          name: recent.name,
          role: check.projectRole,
          isArchived: check.isArchived,
        }
      }
    })
    recentItems = visible
    projectInfo = { ...projectInfo, ...found }
  }

  /** The caller's role per project, for "New secret in X"; a failed lookup offers no action. */
  async function ensureProjectInfo(ids: string[]) {
    const current = generation
    const missing = ids.filter((id) => !(id in projectInfo))
    const loaded = await Promise.all(
      missing.map(async (id): Promise<KnownProject | null> => {
        try {
          const project = await getProject(fetch, id)
          return {
            id,
            name: project.name,
            role: project.role,
            isArchived: project.archivedAt !== null,
          }
        } catch {
          return null
        }
      })
    )
    if (current !== generation) return
    const found: Record<string, KnownProject> = {}
    for (const entry of loaded) if (entry) found[entry.id] = entry
    projectInfo = { ...projectInfo, ...found }
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (open) closeSearch()
      else openPalette()
    }
  }

  async function runSearch(term: string) {
    if (!term.trim()) {
      results = []
      loading = false
      return
    }
    if (abortController) abortController.abort()
    abortController = new AbortController()
    loading = true
    try {
      // The signal scopes to the search request only; it must never reach the shared session
      // refresh apiFetch may issue on a 401 (Story 61.3).
      const data = await globalSearch(fetch, {
        q: term.trim(),
        limit: 10,
        signal: abortController.signal,
      })
      results = data.results
      selectedIndex = 0
      void ensureProjectInfo(
        data.results.flatMap((item) => (item.type === 'project' ? [item.id] : [])).slice(0, 3)
      )
    } catch (error) {
      if ((error as Error).name !== 'AbortError') results = []
    } finally {
      loading = false
    }
  }

  function handleQueryInput() {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => runSearch(query), 200)
  }

  function toRecent(item: SearchResultItem): RecentItem {
    return item.type === 'credential'
      ? {
          type: 'credential',
          id: item.id,
          projectId: item.projectId,
          name: item.name,
          projectName: item.projectName,
        }
      : { type: 'project', id: item.id, name: item.name }
  }

  async function openRecord(
    record: { type: 'credential'; id: string; projectId: string } | { type: 'project'; id: string }
  ) {
    closeSearch()
    if (record.type === 'credential') {
      await goto(resolve(`/projects/${record.projectId}/credentials/${record.id}`))
    } else {
      await goto(resolve(`/projects/${record.id}`))
    }
  }

  async function navigate(item: SearchResultItem) {
    if (userId) addRecent(userId, toRecent(item))
    await openRecord(item)
  }

  async function goToTarget(target: PaletteTarget) {
    closeSearch()
    if (target.to === 'create-project') await goto(resolve('/projects/new'))
    else if (target.to === 'audit-log') await goto(resolve('/settings/audit'))
    else await goto(resolve(`/projects/${target.projectId}/credentials/new`))
  }

  /** A recent is re-checked server-side on selection: one that can no longer be opened is dropped
   * and never navigated to, and the palette says so. */
  let openingRecent = false
  async function openRecent(recent: RecentItem) {
    if (openingRecent) return
    openingRecent = true
    try {
      await openCheckedRecent(recent)
    } finally {
      openingRecent = false
    }
  }

  async function openCheckedRecent(recent: RecentItem) {
    notice = null
    const current = generation
    const check = await checkRecent(fetch, recent)
    // The palette was closed (or reopened) while the check ran: do not navigate on its behalf.
    if (!open || current !== generation) return
    if (check.status === 'ok') {
      if (userId) addRecent(userId, recent)
      await openRecord(recent)
      return
    }
    if (check.status === 'gone') {
      if (userId) removeRecent(userId, recent)
      recentItems = recentItems.filter(
        (item) => !(item.type === recent.type && item.id === recent.id)
      )
      notice = 'That item is no longer available.'
    } else {
      notice = 'Could not open that item. Try again.'
    }
  }

  async function selectRow(row: PaletteRow) {
    if (row.group === 'actions') await goToTarget(row.action.target)
    else if (row.group === 'recent') await openRecent(row.recent)
    else await navigate(row.item)
  }

  function selectCurrent() {
    const row = rows[selectedIndex]
    if (row) void selectRow(row)
  }

  function handlePaletteKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (rows.length > 0) selectedIndex = (selectedIndex + 1) % rows.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length > 0) selectedIndex = (selectedIndex - 1 + rows.length) % rows.length
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      selectCurrent()
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) closeSearch()
  }

  // Rows can shrink while results and checks arrive; keep the highlight on a row that exists.
  $effect(() => {
    if (selectedIndex >= rows.length) selectedIndex = 0
  })

  // The layout opens the palette by setting `open` (header button, Ctrl/Cmd-K), so recents load when
  // `open` turns true, whoever set it.
  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) {
      notice = null
      untrack(() => void loadRecents())
    }
    wasOpen = open
  })

  $effect(() => {
    if (open && dialogRef) {
      cleanupFocusTrap?.()
      cleanupFocusTrap = trapFocus(dialogRef)
      return () => cleanupFocusTrap?.()
    }
    cleanupFocusTrap?.()
    cleanupFocusTrap = undefined
  })

  onMount(() => window.addEventListener('keydown', handleGlobalKeydown))
  onDestroy(() => {
    // onDestroy (unlike onMount) also fires when a component is torn down during SSR, where
    // `window` doesn't exist — guard so a server-rendered (app) page doesn't 500.
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleGlobalKeydown)
    clearTimeout(debounceTimer)
    if (abortController) abortController.abort()
    cleanupFocusTrap?.()
  })
</script>

{#snippet highlighted(text: string)}
  {#each highlightParts(text, query) as part, partIndex (partIndex)}
    {#if part.match}<mark class="bg-amber-100">{part.text}</mark>{:else}{part.text}{/if}
  {/each}
{/snippet}

{#if open}
  <div
    bind:this={dialogRef}
    class="fixed inset-0 z-[60] flex items-start justify-center bg-slate-950/50 p-4 pt-[10vh]"
    role="presentation"
    onclick={handleBackdropClick}
    onkeydown={handlePaletteKeydown}
  >
    <div
      class="w-full max-w-2xl rounded-2xl bg-white shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
    >
      <div class="border-b border-slate-200 p-4">
        <input
          bind:this={inputRef}
          bind:value={query}
          class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-3 text-base"
          type="search"
          placeholder="Search secrets, projects…"
          aria-label="Search"
          aria-autocomplete="list"
          aria-controls="global-search-results"
          autocomplete="off"
          oninput={handleQueryInput}
          aria-describedby="global-search-help"
        />
        <FormHelpText id="global-search-help" kind="search" />
      </div>

      <p class={notice ? 'px-4 pt-3 text-sm text-amber-900' : 'sr-only'} role="status">
        {notice ?? ''}
      </p>

      {#if rows.length > 0}
        <ul id="global-search-results" class="max-h-[50vh] overflow-y-auto p-2" role="listbox">
          {#each rows as row, index (row.group + row.id)}
            {#if index === 0 || rows[index - 1]?.group !== row.group}
              <li role="presentation" class="px-3 pb-1 pt-2 text-xs font-semibold text-slate-600">
                {GROUP_LABEL[row.group]}
              </li>
            {/if}
            <li
              role="option"
              aria-selected={index === selectedIndex}
              class={`rounded-xl ${index === selectedIndex ? 'bg-slate-100' : ''}`}
            >
              <button
                type="button"
                class="w-full cursor-pointer rounded-xl px-3 py-3 text-left hover:bg-slate-50"
                onclick={() => void selectRow(row)}
              >
                {#if row.group === 'actions'}
                  <span class="font-medium text-slate-950">{row.action.label}</span>
                {:else if row.group === 'recent'}
                  {#if row.recent.type === 'credential'}
                    <span class="text-sm font-semibold text-slate-500">
                      {row.recent.projectName}
                    </span>
                    <span class="text-slate-400">/</span>
                    <span class="font-medium text-slate-950">{row.recent.name}</span>
                  {:else}
                    <span class="font-medium text-slate-950">{row.recent.name}</span>
                  {/if}
                {:else}
                  {@const item = row.item}
                  {#if item.type === 'credential'}
                    <div class="flex flex-wrap items-center gap-2 text-sm">
                      <span class="font-semibold text-slate-500">{item.projectName}</span>
                      <span class="text-slate-400">/</span>
                      <span class="font-medium text-slate-950">
                        {@render highlighted(item.name)}
                      </span>
                      {#if item.expiresAt && expiresWithinDays(item.expiresAt)}
                        <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                          expires in {daysUntil(item.expiresAt)} days
                        </span>
                      {/if}
                    </div>
                    {#if item.snippet}
                      <p class="mt-1 text-sm text-slate-600">
                        {@render highlighted(item.snippet)}
                      </p>
                    {/if}
                  {:else}
                    <div class="font-medium text-slate-950">
                      {@render highlighted(item.name)}
                    </div>
                    <p class="mt-1 text-sm text-slate-600">
                      {item.credentialCount} secrets
                      {#if item.snippet}
                        · {@render highlighted(item.snippet)}
                      {/if}
                    </p>
                  {/if}
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if loading}
        <p class="sr-only" aria-live="polite">Searching…</p>
        <div class="flex justify-center p-6">
          <div
            class="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900"
            aria-hidden="true"
          ></div>
        </div>
      {:else if query.trim() && results.length === 0}
        <p class="p-6 text-slate-700">No results for "{query}"</p>
      {/if}

      <footer class="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
        <kbd class="rounded border border-slate-300 px-1">↑↓</kbd> navigate ·
        <kbd class="rounded border border-slate-300 px-1">↵</kbd> select ·
        <kbd class="rounded border border-slate-300 px-1">Esc</kbd> close
      </footer>
    </div>
  </div>
{/if}
