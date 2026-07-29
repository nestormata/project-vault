<script lang="ts">
  import { resolve } from '$app/paths'
  import { patchThemeSelection } from '$lib/api/themes.js'
  import { setAppliedTheme } from '$lib/state/theme.svelte.js'
  import type { ThemesPageData } from './+page.server.js'

  const { data }: { data: ThemesPageData } = $props()

  let selected = $state(data.selected)
  let saving = $state<string | null>(null)
  let errorMessage = $state<string | null>(null)

  // AC-3 second edge case: a stored selection that no longer appears in the currently-compiled
  // set is shown as its own distinct, disabled "currently unavailable" option — never silently
  // defaulted to "Default" in this radio group, so the user isn't confused about what's actually
  // stored vs. what's currently applied (that distinction is the (app) layout's orphaned-theme
  // notice, a separate concern from this page).
  const availableNames = $derived(data.themes.map((theme) => theme.name))
  const orphanedSelection = $derived(
    selected !== null && !availableNames.includes(selected) ? selected : null
  )

  async function selectTheme(themeName: string | null) {
    if (saving) return
    saving = themeName ?? 'base'
    errorMessage = null
    try {
      const result = await patchThemeSelection(fetch, themeName)
      // AC-2: pessimistic — only apply the new theme app-wide after the server confirms the
      // save, never optimistically on click.
      selected = result.themeName
      setAppliedTheme(result.themeName)
    } catch {
      errorMessage = 'Failed to save your theme selection, try again.'
    } finally {
      saving = null
    }
  }
</script>

<svelte:head>
  <title>Themes | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <a href={resolve('/settings')} class="text-sm text-indigo-600 hover:text-indigo-800">← Settings</a
  >
  <h1 class="mt-2 text-2xl font-bold text-gray-900">Themes</h1>
  <p class="mt-2 text-gray-500">Choose which installed theme is active for your view.</p>

  {#if errorMessage}
    <p class="mt-4 text-sm text-red-600" role="alert">{errorMessage}</p>
  {/if}

  {#if data.errorMessage}
    <p class="mt-4 text-sm text-red-600" role="alert">{data.errorMessage}</p>
  {:else}
    <ul class="mt-6 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
      {#each data.themes as theme (theme.name)}
        <li class="flex items-center justify-between px-6 py-4">
          <label class="flex items-center gap-3">
            <input
              type="radio"
              name="theme"
              value={theme.name}
              checked={selected === theme.name || (selected === null && theme.name === 'base')}
              disabled={saving !== null}
              onchange={() => selectTheme(theme.name === 'base' ? null : theme.name)}
            />
            <span class="font-medium text-gray-900">{theme.label}</span>
          </label>
        </li>
      {/each}
      {#if orphanedSelection}
        <li class="flex items-center justify-between px-6 py-4">
          <label class="flex items-center gap-3 text-gray-400">
            <input type="radio" name="theme" checked disabled />
            <span class="font-medium">{orphanedSelection} (currently unavailable)</span>
          </label>
        </li>
      {/if}
    </ul>
  {/if}
</div>
