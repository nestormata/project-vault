<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { onDestroy, onMount } from 'svelte'
  import { globalSearch, type SearchResultItem } from '$lib/api/search.js'
  import { trapFocus } from '$lib/components/onboarding/focus-trap.js'
  import { daysUntil, expiresWithinDays, highlightParts } from './search-ui.js'

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

  const flatResults = $derived(results)

  function closeSearch() {
    open = false
    query = ''
    results = []
    selectedIndex = 0
    loading = false
    if (abortController) abortController.abort()
    previousFocus?.focus()
  }

  function openPalette() {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    open = true
    query = ''
    results = []
    selectedIndex = 0
    queueMicrotask(() => inputRef?.focus())
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
      const data = await globalSearch(
        (input, init) => fetch(input, { ...init, signal: abortController?.signal }),
        { q: term.trim(), limit: 10 }
      )
      results = data.results
      selectedIndex = 0
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

  async function navigate(item: SearchResultItem) {
    closeSearch()
    if (item.type === 'credential') {
      await goto(resolve(`/projects/${item.projectId}/credentials/${item.id}`))
    } else {
      await goto(resolve(`/projects/${item.id}`))
    }
  }

  function selectCurrent() {
    const item = flatResults[selectedIndex]
    if (item) void navigate(item)
  }

  function handlePaletteKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (flatResults.length > 0) selectedIndex = (selectedIndex + 1) % flatResults.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (flatResults.length > 0)
        selectedIndex = (selectedIndex - 1 + flatResults.length) % flatResults.length
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
    window.removeEventListener('keydown', handleGlobalKeydown)
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
          class="w-full rounded-xl border border-slate-300 px-4 py-3 text-base"
          type="search"
          placeholder="Search credentials, projects…"
          aria-label="Search"
          aria-autocomplete="list"
          aria-controls="global-search-results"
          autocomplete="off"
          oninput={handleQueryInput}
        />
      </div>

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
      {:else if results.length > 0}
        <ul id="global-search-results" class="max-h-[50vh] overflow-y-auto p-2" role="listbox">
          {#each flatResults as item, index (item.type + item.id)}
            <li
              role="option"
              aria-selected={index === selectedIndex}
              class={`rounded-xl ${index === selectedIndex ? 'bg-slate-100' : ''}`}
            >
              <button
                type="button"
                class="w-full cursor-pointer rounded-xl px-3 py-3 text-left hover:bg-slate-50"
                onclick={() => navigate(item)}
              >
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
                    {item.credentialCount} credentials
                    {#if item.snippet}
                      · {@render highlighted(item.snippet)}
                    {/if}
                  </p>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <footer class="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
        <kbd class="rounded border border-slate-300 px-1">↑↓</kbd> navigate ·
        <kbd class="rounded border border-slate-300 px-1">↵</kbd> select ·
        <kbd class="rounded border border-slate-300 px-1">Esc</kbd> close
      </footer>
    </div>
  </div>
{/if}
