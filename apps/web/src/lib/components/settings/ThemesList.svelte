<script lang="ts">
  import type { ThemesPageData } from '../../../routes/(app)/settings/themes/+page.server.js'
  import type { Snippet } from 'svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  let {
    loadError,
    themes,
    selected,
    saving,
    orphanedSelection,
    selectTheme,
    children,
  }: {
    loadError: ThemesPageData['errorMessage']
    themes: ThemesPageData['themes']
    selected: string | null
    saving: string | null
    orphanedSelection: string | null
    selectTheme: (themeName: string | null) => Promise<void>
    children?: Snippet
  } = $props()
</script>

{#if loadError}
  <p class="mt-4 text-sm text-red-600" role="alert">{loadError}</p>
{:else}
  <ul class="mt-6 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
    {#each themes as theme (theme.name)}
      <li class="flex items-center justify-between px-6 py-4">
        <label class="flex items-center gap-3">
          <input
            type="radio"
            name="theme"
            value={theme.name}
            checked={selected === theme.name || (selected === null && theme.name === 'base')}
            disabled={saving !== null}
            onchange={() => selectTheme(theme.name === 'base' ? null : theme.name)}
            aria-describedby="theme-selection-help"
          />
          <span class="font-medium text-gray-900">{theme.label}</span>
        </label>
      </li>
    {/each}
    <FormHelpText id="theme-selection-help" kind="radio" />
    {#if orphanedSelection}
      <li class="flex items-center justify-between px-6 py-4">
        <label class="flex items-center gap-3 text-gray-400">
          <input
            type="radio"
            name="theme"
            checked
            disabled
            aria-describedby="theme-selection-help"
          />
          <span class="font-medium">{orphanedSelection} (currently unavailable)</span>
        </label>
      </li>
    {/if}
  </ul>
{/if}
{@render children?.()}
